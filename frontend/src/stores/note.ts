/**
 * 笔记工作台 Pinia Store
 *
 * 设计要点：
 * 1. 后端 notebook/list 直接返回树形结构（NotebookNode[]），前端单一数据源 notebookTree
 * 2. 笔记按 notebook_id 维度缓存（notesByCategory），避免重复请求
 * 3. 聚合笔记（aggregatedNotes）缓存"某节点下所有笔记 id 集合"，切换分类时秒出
 * 4. 当前选中的笔记本/分类/笔记用 ref 跟踪，所有组件通过 store 联动
 * 5. create/update/sort 通过不可变递归更新 notebookTree，保持响应式
 */
import { defineStore } from "pinia";
import * as notebookApi from "@/api/notebook";
import * as noteApi from "@/api/note";
import { fetchNoteById, fetchTrashNotes, permanentDeleteNote, emptyTrash as apiEmptyTrash } from "@/api/note";
import { fetchMyShares } from "@/api/share";
import type { CreateNotebookPayload, CreateNotePayload, Note, Notebook, NotebookNode, SortNoteItem, SortNotebookItem, ShareItem } from "@/types/note";

interface LoadingState {
    tree: boolean;     // 笔记本树加载中
    notes: boolean;    // 笔记列表加载中
    save: boolean;     // 创建/更新操作中
    search: boolean;   // 全文搜索中
    noteDetail: boolean; // 单条笔记详情加载中
    trash: boolean;    // 回收站列表加载中
    shares: boolean;   // 分享列表加载中
}

/** sessionStorage 存储 key 常量 */
const SESSION_KEYS = {
    notebook: "note-active-notebook-id",
    category: "note-active-category-id",
    note: "note-active-note-id",
};

/** 从 sessionStorage 读取 ID，无值时返回 null */
const readSessionId = (key: string): number | null => {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
};

/** 写入 sessionStorage（null 时清除） */
const writeSessionId = (key: string, val: number | null): void => {
    if (val === null) {
        sessionStorage.removeItem(key);
    } else {
        sessionStorage.setItem(key, String(val));
    }
};

/** 从 localStorage 读取 ID，无值时返回 null */
const readLocalId = (key: string): number | null => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
};

/** 写入 localStorage（null 时清除） */
const writeLocalId = (key: string, val: number | null): void => {
    if (val === null) {
        localStorage.removeItem(key);
    } else {
        localStorage.setItem(key, String(val));
    }
};

// ==================== 树操作工具函数（纯函数，不可变更新） ====================

/**
 * 在树中递归查找指定 id 的节点
 * @returns 匹配节点，未找到返回 null
 */
const findNodeById = (tree: NotebookNode[], id: number): NotebookNode | null => {
    for (const node of tree) {
        if (node.id === id) return node;
        if (node.children.length > 0) {
            const found = findNodeById(node.children, id);
            if (found) return found;
        }
    }
    return null;
};

/**
 * 将新节点插入树中（不可变，返回新树）
 * - parent_id 为 null：插入顶层，按 sort_order 重新排序
 * - parent_id 不为 null：递归找到父节点，插入其 children 并重新排序
 */
const insertNodeIntoTree = (tree: NotebookNode[], newNode: NotebookNode): NotebookNode[] => {
    if (newNode.parent_id === null) {
        return [...tree, newNode].sort((a, b) => a.sort_order - b.sort_order);
    }
    return tree.map((node) => {
        if (node.id === newNode.parent_id) {
            return {
                ...node,
                children: [...node.children, newNode].sort((a, b) => a.sort_order - b.sort_order),
            };
        }
        if (node.children.length > 0) {
            return { ...node, children: insertNodeIntoTree(node.children, newNode) };
        }
        return node;
    });
};

/**
 * 递归更新树中指定 id 的节点数据（不可变，返回新树）
 * 用 updates 覆盖节点字段，保留原有 children 结构
 */
const updateNodeInTree = (
    tree: NotebookNode[],
    id: number,
    updates: Notebook,
): NotebookNode[] => {
    return tree.map((node) => {
        if (node.id === id) {
            // 展开 updates 覆盖可变字段，显式保留 children
            return { ...node, ...updates, children: node.children };
        }
        if (node.children.length > 0) {
            return { ...node, children: updateNodeInTree(node.children, id, updates) };
        }
        return node;
    });
};

/**
 * 批量更新树中节点的 sort_order 并对每层重新排序（不可变，返回新树）
 * @param sortMap id → sort_order 映射
 */
const updateSortOrderInTree = (
    tree: NotebookNode[],
    sortMap: Map<number, number>,
): NotebookNode[] => {
    return tree
        .map((node) => {
            const newSort = sortMap.get(node.id);
            const updated = newSort !== undefined
                ? { ...node, sort_order: newSort }
                : node;
            if (updated.children.length > 0) {
                return { ...updated, children: updateSortOrderInTree(updated.children, sortMap) };
            }
            return updated;
        })
        .sort((a, b) => a.sort_order - b.sort_order);
};

/**
 * 从树中收集指定 id 集合的所有子孙节点 id（递归）
 * @returns 包含入参 rootIds 及所有子孙节点的完整 ID 集合
 */
const collectDescendantIdsFromTree = (
    tree: NotebookNode[],
    rootIds: Set<number>,
): Set<number> => {
    const result = new Set<number>();
    const collect = (node: NotebookNode) => {
        result.add(node.id);
        for (const child of node.children) {
            collect(child);
        }
    };
    const traverse = (nodes: NotebookNode[]) => {
        for (const node of nodes) {
            if (rootIds.has(node.id)) {
                collect(node);
            } else if (node.children.length > 0) {
                traverse(node.children);
            }
        }
    };
    traverse(tree);
    return result;
};

/**
 * 从树中递归移除指定 id 集合的节点（不可变，返回新树）
 * - 若节点 id 在 ids 中，直接移除该节点及其子树
 * - 否则递归检查其 children，过滤掉匹配的子节点
 * @returns 过滤后的新树
 */
const removeNodeFromTree = (
    tree: NotebookNode[],
    ids: Set<number>,
): NotebookNode[] => {
    return tree
        .filter((node) => !ids.has(node.id))
        .map((node) => {
            if (node.children.length > 0) {
                return { ...node, children: removeNodeFromTree(node.children, ids) };
            }
            return node;
        });
};

/**
 * 在树中找到指定节点的顶层祖先 id（顶层笔记本）
 * 从 root 遍历，若 targetId 属于某个 root 或其后代，返回该 root 的 id
 */
const findTopLevelAncestor = (tree: NotebookNode[], targetId: number): number | null => {
    const contains = (node: NotebookNode, id: number): boolean => {
        if (node.id === id) return true;
        for (const child of node.children) {
            if (contains(child, id)) return true;
        }
        return false;
    };
    for (const root of tree) {
        if (contains(root, targetId)) return root.id;
    }
    return null;
};

export const useNoteStore = defineStore("note", {
    state: () => ({
        /** 笔记本树（后端返回的树形结构，顶层节点数组，子节点嵌在 children 里） */
        notebookTree: [] as NotebookNode[],
        /** 已加载过笔记的分类 id 集合（用于避免重复请求） */
        loadedCategoryIds: new Set<number>(),
        /** 分类 id → 该分类下的笔记列表 */
        notesByCategory: {} as Record<number, Note[]>,
        /** 当前选中的笔记本（顶层）id（优先从 sessionStorage 恢复） */
        activeNotebookId: readLocalId(SESSION_KEYS.notebook),
        /** 当前选中的分类 id（null 表示未选中）（优先从 sessionStorage 恢复） */
        activeCategoryId: readSessionId(SESSION_KEYS.category),
        /** 当前选中的笔记 id（优先从 sessionStorage 恢复） */
        activeNoteId: readSessionId(SESSION_KEYS.note),
        /** 单条笔记数据（优先于 noteMap 的缓存，由 selectNote / fetchNoteDetail 填充） */
        activeNoteData: null as Note | null,
        /** 是否处于搜索态（第二栏显示搜索结果而非分类列表） */
        searchMode: false,
        /** 当前搜索关键词 */
        searchKeyword: "",
        /** 搜索结果列表（跨分类，按 BM25 相关性排序） */
        searchResults: [] as Note[],
        /** 是否处于回收站模式 */
        trashMode: false,
        /** 回收站笔记列表（最近删除，最多 200 条） */
        trashNotes: [] as Note[],
        /** 是否处于分享管理模式 */
        sharesMode: false,
        /** 我的分享列表（最多 100 条） */
        myShares: [] as ShareItem[],
        /** 加载状态 */
        loading: {
            tree: false,
            notes: false,
            save: false,
            search: false,
            noteDetail: false,
            trash: false,
            shares: false,
        } as LoadingState,
    }),

    getters: {
        /**
         * 当前选中的笔记本节点（顶层笔记本，直接在 notebookTree 顶层查找）
         */
        activeNotebook(state): NotebookNode | null {
            if (state.activeNotebookId === null) return null;
            return state.notebookTree.find((n) => n.id === state.activeNotebookId) ?? null;
        },

        /**
         * 当前选中的分类节点（可在任意层级，递归查找）
         */
        activeCategory(state): NotebookNode | null {
            if (state.activeCategoryId === null) return null;
            return findNodeById(state.notebookTree, state.activeCategoryId);
        },

        /**
         * 笔记索引 Map（id → Note）
         * 从所有分类缓存 + 搜索结果中聚合，供 O(1) 查找
         * 仅 notesByCategory / searchResults 变化时重建
         */
        noteMap(state): Map<number, Note> {
            const map = new Map<number, Note>();
            for (const list of Object.values(state.notesByCategory)) {
                for (const note of list) {
                    map.set(note.id, note);
                }
            }
            for (const note of state.searchResults) {
                map.set(note.id, note);
            }
            return map;
        },

        /**
         * 当前选中的笔记
         * 优先从 activeNoteData（单独 API 拉取），未命中时 fallback noteMap（列表缓存）
         */
        activeNote(): Note | null {
            if (this.activeNoteId === null) return null;
            return this.activeNoteData ?? this.noteMap.get(this.activeNoteId) ?? null;
        },

        /**
         * 第二栏展示用：搜索态返回搜索结果，否则返回当前选中分类下的直属笔记列表
         *
         * 正常态：只取该分类自身的笔记（不含后代分类），排除软删除后排序
         * 排序口径与后端 listNotes 一致：置顶在前 → sort_order 升序 → 创建时间倒序
         */
        displayedNotes(state): Note[] {
            // 回收站模式：直接返回回收站列表
            if (state.trashMode) return state.trashNotes;

            // 搜索态：直接返回搜索结果（已按 BM25 排序，不重新排序）
            if (state.searchMode) return state.searchResults;

            if (state.activeCategoryId === null) return [];

            const list = state.notesByCategory[state.activeCategoryId] ?? [];
            return list
                .filter((n) => n.is_deleted === 0)
                .sort((a, b) => {
                    if (a.is_pinned !== b.is_pinned) return b.is_pinned - a.is_pinned;            // 置顶在前
                    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;       // sort_order 升序
                    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); // 创建时间倒序
                });
        },

        /**
         * 根据 notebook_id（分类 id）查询分类名称
         * 用于搜索结果中显示笔记所属分类
         */
        getCategoryName(state): (notebookId: number) => string {
            return (notebookId: number) => {
                const node = findNodeById(state.notebookTree, notebookId);
                return node?.title ?? "";
            };
        },
    },

    actions: {
        /**
         * 加载笔记本树（首次进入工作台时调用）
         * 后端直接返回树形结构，无需前端组装
         * 如果 sessionStorage 中保存了上次选中的分类和笔记，一并恢复
         */
        async loadNotebookTree() {
            this.loading.tree = true;
            try {
                const tree = await notebookApi.fetchNotebookList();
                this.notebookTree = tree;

                // 默认选中第一个顶层笔记本（仅在 sessionStorage 无缓存时）
                if (this.activeNotebookId === null && tree.length > 0) {
                    this.activeNotebookId = tree[0].id;
                    writeLocalId(SESSION_KEYS.notebook, this.activeNotebookId);
                } else if (this.activeNotebookId !== null) {
                    // 校验恢复的 notebookId 是否有效，无效则清除
                    const valid = !!findNodeById(tree, this.activeNotebookId);
                    if (!valid) {
                        this.activeNotebookId = null;
                        this.activeCategoryId = null;
                        this.activeNoteId = null;
                        writeLocalId(SESSION_KEYS.notebook, null);
                        writeSessionId(SESSION_KEYS.category, null);
                        writeSessionId(SESSION_KEYS.note, null);
                    }
                }

                // 恢复上次选中的分类：只加载该分类自身的笔记缓存
                if (this.activeCategoryId !== null) {
                    const savedNoteId = this.activeNoteId;
                    // 先清空笔记选中，保证后续恢复时（null→id）触发 watch 更新草稿
                    this.activeNoteId = null;
                    // 校验恢复的 categoryId 是否有效
                    const catValid = !!findNodeById(tree, this.activeCategoryId);
                    if (!catValid) {
                        this.activeCategoryId = null;
                        writeSessionId(SESSION_KEYS.category, null);
                        writeSessionId(SESSION_KEYS.note, null);
                        return;
                    }
                    // 只加载当前分类的笔记缓存
                    if (!this.loadedCategoryIds.has(this.activeCategoryId)) {
                        await this.loadCategoryNotes(this.activeCategoryId);
                    }
                    // 恢复笔记选中
                    if (savedNoteId !== null) {
                        this.activeNoteId = savedNoteId;
                    }
                }

                // 如果没有缓存的分类，自动选择当前笔记本的第一个分类
                if (this.activeCategoryId === null && this.activeNotebookId !== null) {
                    const notebook = this.notebookTree.find(n => n.id === this.activeNotebookId);
                    if (notebook && notebook.children.length > 0) {
                        const firstCategory = notebook.children[0];
                        this.activeCategoryId = firstCategory.id;
                        writeSessionId(SESSION_KEYS.category, firstCategory.id);
                        // 按需加载该分类的笔记
                        if (!this.loadedCategoryIds.has(firstCategory.id)) {
                            await this.loadCategoryNotes(firstCategory.id);
                        }
                    }
                }
            } finally {
                this.loading.tree = false;
            }
            // 静默预加载分享数量（只填充 myShares，不改 sharesMode）
            fetchMyShares().then((list) => { this.myShares = list; }).catch(() => {});
        },

        /**
         * 切换顶层笔记本
         * 切换后自动选中该笔记本下的第一个分类，清空搜索态和回收站模式，同步写入 sessionStorage
         */
        switchNotebook(id: number) {
            this.activeNotebookId = id;
            this.searchMode = false;
            this.searchKeyword = "";
            this.searchResults = [];
            if (this.trashMode) this.exitTrashMode();
            writeLocalId(SESSION_KEYS.notebook, id);

            // 自动选择该笔记本下的第一个分类
            const notebook = this.notebookTree.find(n => n.id === id);
            if (notebook && notebook.children.length > 0) {
                const firstCategory = notebook.children[0];
                this.activeCategoryId = firstCategory.id;
                this.activeNoteId = null;
                writeSessionId(SESSION_KEYS.category, firstCategory.id);
                writeSessionId(SESSION_KEYS.note, null);
                // 按需加载该分类的笔记
                if (!this.loadedCategoryIds.has(firstCategory.id)) {
                    this.loadCategoryNotes(firstCategory.id);
                }
            } else {
                // 没有子分类时，清空选中
                this.activeCategoryId = null;
                this.activeNoteId = null;
                writeSessionId(SESSION_KEYS.category, null);
                writeSessionId(SESSION_KEYS.note, null);
            }
        },

        /**
         * 选中分类，按需加载该分类下的笔记，同步写入 sessionStorage
         * 若当前在回收站模式，自动退出
         */
        async selectCategory(id: number | null) {
            if (this.trashMode) this.exitTrashMode();
            if (this.sharesMode) this.exitSharesMode();
            this.activeCategoryId = id;
            this.activeNoteId = null;
            writeSessionId(SESSION_KEYS.category, id);
            writeSessionId(SESSION_KEYS.note, null);
            if (id !== null && !this.loadedCategoryIds.has(id)) {
                await this.loadCategoryNotes(id);
            }
        },

        /**
         * 加载指定分类的笔记（带缓存）
         */
        async loadCategoryNotes(categoryId: number) {
            this.loading.notes = true;
            try {
                const notes = await noteApi.fetchNoteList(categoryId);
                this.notesByCategory = { ...this.notesByCategory, [categoryId]: notes };
                this.loadedCategoryIds.add(categoryId);
            } finally {
                this.loading.notes = false;
            }
        },

        /**
         * 选中笔记，优先从缓存取，无缓存时调 API 获取
         * 同步写入 sessionStorage
         */
        async selectNote(id: number | null) {
            this.activeNoteId = id;
            writeSessionId(SESSION_KEYS.note, id);

            if (id === null) {
                this.activeNoteData = null;
                return;
            }

            // 优先从 noteMap 缓存取
            const cached = this.noteMap.get(id);
            if (cached) {
                this.activeNoteData = cached;
                this.loading.noteDetail = false;
                return;
            }

            // 缓存未命中，调 API 获取
            this.loading.noteDetail = true;
            try {
                const note = await fetchNoteById(id);
                // 防止竞态：API 返回时 activeNoteId 可能已改变，仅匹配时才写入
                if (this.activeNoteId === id) {
                    this.activeNoteData = note;
                }
            } finally {
                if (this.activeNoteId === id) {
                    this.loading.noteDetail = false;
                }
            }
        },

        /**
         * Deep-link 用：根据笔记 ID 自动定位到所属分类并选中笔记
         * 1. 调 API 取笔记详情以获取 notebook_id
         * 2. 在 notebookTree 中找到该分类的顶层笔记本
         * 3. 切换笔记本 → 选中分类 → 加载分类笔记 → 选中笔记
         * @param noteId 笔记 ID
         */
        async locateAndSelectNote(noteId: number) {
            // 1. 获取笔记详情（取 notebook_id）
            const note = await fetchNoteById(noteId);
            if (!note) return;

            // 2. 在笔记本树中找到该分类的顶层笔记本
            const topLevelId = findTopLevelAncestor(this.notebookTree, note.notebook_id);
            if (topLevelId === null) return;

            // 3. 切换到顶层笔记本（会重置 activeCategoryId / activeNoteId）
            this.activeNotebookId = topLevelId;
            writeLocalId(SESSION_KEYS.notebook, topLevelId);

            // 4. 选中笔记所属分类（按需加载该分类的笔记列表）
            this.activeCategoryId = note.notebook_id;
            writeSessionId(SESSION_KEYS.category, note.notebook_id);
            if (!this.loadedCategoryIds.has(note.notebook_id)) {
                await this.loadCategoryNotes(note.notebook_id);
            }

            // 5. 直接使用已获取的笔记数据，避免二次 API 请求
            this.activeNoteId = noteId;
            writeSessionId(SESSION_KEYS.note, noteId);
            this.activeNoteData = note;
            this.loading.noteDetail = false;
        },

        /**
         * 创建笔记本（顶层）或子分类
         * 后端返回扁平 Notebook，前端补 children 后插入树中合适位置
         */
        async createNotebook(payload: CreateNotebookPayload) {
            this.loading.save = true;
            try {
                const result = await notebookApi.createNotebook(payload);
                if (result) {
                    // 后端返回扁平节点，补 children 转为树节点
                    const newNode: NotebookNode = { ...result, children: [] };
                    this.notebookTree = insertNodeIntoTree(this.notebookTree, newNode);
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 更新笔记本/分类
         * 更新成功后递归更新树中对应节点（保留 children 结构）
         */
        async updateNotebook(id: number, payload: { title?: string; description?: string; parent_id?: number | null }) {
            this.loading.save = true;
            try {
                const result = await notebookApi.updateNotebook(id, payload);
                if (result) {
                    this.notebookTree = updateNodeInTree(this.notebookTree, id, result);
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 移动分类到新的父节点
         * 移动后整个树结构发生变化，直接重载树
         * @param id 被移动的分类 ID
         * @param parentId 目标父节点 ID（null 表示移到顶层）
         */
        async moveCategory(id: number, parentId: number | null) {
            this.loading.save = true;
            try {
                const result = await notebookApi.updateNotebook(id, { parent_id: parentId });
                if (result) {
                    await this.loadNotebookTree();
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 移动笔记到新的分类
         * 移动后从旧分类缓存中移除，并写入目标分类缓存
         * @param id 被移动的笔记 ID
         * @param targetCategoryId 目标分类 ID
         */
        async moveNote(id: number, targetCategoryId: number) {
            this.loading.save = true;
            try {
                const oldCategoryId = this.noteMap.get(id)?.notebook_id;
                const result = await noteApi.updateNote(id, { notebook_id: targetCategoryId });
                if (result) {
                    // 从旧分类缓存中移除
                    if (oldCategoryId !== undefined) {
                        const oldList = this.notesByCategory[oldCategoryId];
                        if (oldList) {
                            this.notesByCategory = {
                                ...this.notesByCategory,
                                [oldCategoryId]: oldList.filter((n) => n.id !== id),
                            };
                        }
                    }
                    // 将笔记写入目标分类缓存（若已加载则追加，未加载则后续 selectCategory 会加载）
                    if (this.loadedCategoryIds.has(targetCategoryId)) {
                        const targetList = this.notesByCategory[targetCategoryId] ?? [];
                        this.notesByCategory = {
                            ...this.notesByCategory,
                            [targetCategoryId]: [result, ...targetList],
                        };
                    }
                    // 搜索态下同步更新
                    if (this.searchMode) {
                        const sidx = this.searchResults.findIndex((n) => n.id === id);
                        if (sidx !== -1) {
                            this.searchResults = this.searchResults.map((n, i) =>
                                i === sidx ? result : n,
                            );
                        }
                    }
                    // 回收站模式下移动笔记（即恢复），从回收站列表中移除
                    if (this.trashMode) {
                        this.trashNotes = this.trashNotes.filter((n) => n.id !== id);
                    }
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 批量排序分类（同级内拖动排序）
         * 前端传全量 items，后端事务更新后返回该父节点下排序后的子分类列表
         * 用返回数据递归更新树中对应节点的 sort_order，并对各层重新排序
         * @param items 分类 id 及对应排序值
         */
        async sortNotebooks(items: SortNotebookItem[]) {
            this.loading.save = true;
            try {
                const result = await notebookApi.sortNotebooks(items);
                if (result) {
                    // 构建 id → sort_order 映射，递归更新并重新排序
                    const sortMap = new Map(result.map((n) => [n.id, n.sort_order]));
                    this.notebookTree = updateSortOrderInTree(this.notebookTree, sortMap);
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 删除笔记本/分类列表（硬删除），同时软删除其下所有笔记
         * 删除成功后从树中移除对应节点，清理相关缓存和选中状态
         * - 若删的是当前选中的顶层笔记本：自动切到剩余第一个；无剩余则清空选中
         * @param ids 待删除的分类 ID 列表
         */
        async deleteNotebooks(ids: number[]) {
            this.loading.save = true;
            try {
                // 从当前树中收集所有待删分类及其子孙节点的完整 ID 集合
                const allIds = collectDescendantIdsFromTree(this.notebookTree, new Set(ids));

                const result = await notebookApi.deleteNotebooks(ids);
                if (result) {
                    // 用完整 ID 集合从树中移除所有受影响节点
                    this.notebookTree = removeNodeFromTree(this.notebookTree, allIds);

                    // 若删除的节点包含当前选中的分类/笔记，清空选中
                    if (this.activeCategoryId !== null && allIds.has(this.activeCategoryId)) {
                        this.activeCategoryId = null;
                        this.activeNoteId = null;
                        writeSessionId(SESSION_KEYS.category, null);
                        writeSessionId(SESSION_KEYS.note, null);
                    }

                    // 若删除的节点包含当前选中的顶层笔记本：自动切换到剩余第一个；无剩余则清空
                    // 否则下拉框会指向已删除的 ID，状态不一致
                    if (this.activeNotebookId !== null && allIds.has(this.activeNotebookId)) {
                        const next = this.notebookTree[0];
                        if (next) {
                            this.switchNotebook(next.id);
                        } else {
                            this.activeNotebookId = null;
                            this.activeCategoryId = null;
                            this.activeNoteId = null;
                            this.searchMode = false;
                            this.searchKeyword = "";
                            this.searchResults = [];
if (this.trashMode) this.exitTrashMode();
            if (this.sharesMode) this.exitSharesMode();
                            writeLocalId(SESSION_KEYS.notebook, null);
                            writeSessionId(SESSION_KEYS.category, null);
                            writeSessionId(SESSION_KEYS.note, null);
                        }
                    }

                    // 清理所有被删分类的笔记缓存
                    for (const cid of allIds) {
                        delete this.notesByCategory[cid];
                        this.loadedCategoryIds.delete(cid);
                    }
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 创建笔记
         */
        async createNote(payload: CreateNotePayload) {
            this.loading.save = true;
            try {
                const result = await noteApi.createNote(payload);
                if (result) {
                    // 写入对应分类的笔记列表
                    const existing = this.notesByCategory[result.notebook_id] ?? [];
                    this.notesByCategory = {
                        ...this.notesByCategory,
                        [result.notebook_id]: [result, ...existing],
                    };
                    this.loadedCategoryIds.add(result.notebook_id);
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 更新笔记（部分更新）
         * 更新成功后同步更新本地缓存（含分类缓存和搜索结果）
         */
        async updateNote(
            id: number,
            payload: Partial<Pick<import("@/types/note").Note, "title" | "content" | "notebook_id" | "is_pinned" | "sort_order" | "allow_vectorize">>,
            createVersion = true,
        ) {
            this.loading.save = true;
            try {
                const result = await noteApi.updateNote(id, payload, createVersion);
                if (result) {
                    // 同步更新分类缓存中对应的笔记
                    for (const cid of Object.keys(this.notesByCategory)) {
                        const list = this.notesByCategory[Number(cid)];
                        const idx = list.findIndex((n) => n.id === id);
                        if (idx !== -1) {
                            list[idx] = result;
                            this.notesByCategory = { ...this.notesByCategory };
                            break;
                        }
                    }
                    // 搜索态下同步更新搜索结果列表
                    if (this.searchMode) {
                        const sidx = this.searchResults.findIndex((n) => n.id === id);
                        if (sidx !== -1) {
                            this.searchResults = this.searchResults.map((n, i) =>
                                i === sidx ? result : n,
                            );
                        }
                    }
                    // 若更新的是当前激活笔记，同步刷新 activeNoteData
                    if (this.activeNoteId === id) {
                        this.activeNoteData = result;
                    }
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 删除笔记（软删除）
         * 后端置 is_deleted=1，前端从对应分类缓存中移除该笔记；
         * 若删除的是当前激活笔记，清空选中回到空态。
         */
        async deleteNote(id: number) {
            this.loading.save = true;
            try {
                const result = await noteApi.deleteNote(id);
                if (result) {
                    // 从对应分类的笔记列表中移除
                    for (const cid of Object.keys(this.notesByCategory)) {
                        const list = this.notesByCategory[Number(cid)];
                        const idx = list.findIndex((n) => n.id === id);
                        if (idx !== -1) {
                            this.notesByCategory = {
                                ...this.notesByCategory,
                                [Number(cid)]: list.filter((n) => n.id !== id),
                            };
                            break;
                        }
                    }
                    // 若删除的是当前激活笔记，清空选中（第三栏回到空态）
                    if (this.activeNoteId === id) {
                        this.selectNote(null);
                    }
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 彻底删除笔记（硬删除，不可恢复）
         * 后端硬删笔记 + 历史版本 + 关联文件，前端从回收站列表和缓存中移除
         */
        async permanentDeleteNote(id: number) {
            this.loading.save = true;
            try {
                const ok = await permanentDeleteNote(id);
                if (ok) {
                    // 从回收站列表中移除
                    this.trashNotes = this.trashNotes.filter((n) => n.id !== id);
                    // 同时从分类缓存中移除（防止脏数据）
                    for (const cid of Object.keys(this.notesByCategory)) {
                        this.notesByCategory[Number(cid)] = this.notesByCategory[Number(cid)].filter((n) => n.id !== id);
                    }
                    // 若删除的是当前激活笔记，清空选中
                    if (this.activeNoteId === id) {
                        this.selectNote(null);
                    }
                }
                return ok;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 清空回收站（批量硬删除）
         * 调用后端接口删除回收站中所有笔记，成功后清空本地回收站列表
         * @returns 成功删除的笔记数量，失败返回 -1
         */
        async emptyTrash() {
            this.loading.trash = true;
            try {
                const deleted = await apiEmptyTrash();
                if (deleted >= 0) {
                    // 清空回收站列表
                    this.trashNotes = [];
                    // 清空当前选中的笔记（如果有的话）
                    if (this.activeNoteId !== null) {
                        this.activeNoteId = null;
                        this.activeNoteData = null;
                        writeSessionId(SESSION_KEYS.note, null);
                    }
                }
                return deleted;
            } finally {
                this.loading.trash = false;
            }
        },

        /**
         * 批量排序笔记（同分类内拖动排序）
         * 前端传全量 items，后端事务更新后返回该分类排序后的笔记列表
         * 用返回数据覆盖对应分类的本地缓存
         * @param items 笔记 id 及对应排序值
         */
        async sortNotes(items: SortNoteItem[]) {
            this.loading.save = true;
            try {
                const result = await noteApi.sortNotes(items);
                if (result) {
                    // 后端返回的列表属于同一分类，找出 notebook_id 后覆盖本地缓存
                    const notebookId = result[0]?.notebook_id;
                    if (notebookId !== undefined) {
                        this.notesByCategory = {
                            ...this.notesByCategory,
                            [notebookId]: result,
                        };
                    }
                }
                return result;
            } finally {
                this.loading.save = false;
            }
        },

        /**
         * 全文搜索笔记（FTS5 + trigram）
         * 搜索当前顶层笔记本下所有子分类的笔记，结果替换第二栏列表
         * @param keyword 搜索关键词（最少 2 字符）
         */
        async searchNotes(keyword: string) {
            if (this.activeNotebookId === null) return;
            this.loading.search = true;
            this.searchMode = true;
            this.searchKeyword = keyword;
            try {
                const results = await noteApi.searchNotes(this.activeNotebookId, keyword);
                this.searchResults = results ?? [];
            } finally {
                this.loading.search = false;
            }
        },

        /**
         * 清空搜索，恢复分类列表
         */
        clearSearch() {
            this.searchMode = false;
            this.searchKeyword = "";
            this.searchResults = [];
        },

        /**
         * 进入回收站模式
         * 清空分类/笔记选中，请求回收站列表，切换 trashMode
         */
        async enterTrashMode() {
            if (this.sharesMode) this.exitSharesMode();
            this.activeCategoryId = null;
            this.activeNoteId = null;
            writeSessionId(SESSION_KEYS.category, null);
            writeSessionId(SESSION_KEYS.note, null);
            this.trashMode = true;
            this.loading.trash = true;
            try {
                this.trashNotes = await fetchTrashNotes();
            } finally {
                this.loading.trash = false;
            }
        },

        /**
         * 退出回收站模式
         * 清空 trashMode 和回收站列表
         */
        exitTrashMode() {
            this.trashMode = false;
            this.trashNotes = [];
        },

        /**
         * 进入我的分享模式
         * 清空分类/笔记选中，请求分享列表，切换 sharesMode
         */
        async enterSharesMode() {
            if (this.trashMode) this.exitTrashMode();
            this.activeCategoryId = null;
            this.activeNoteId = null;
            writeSessionId(SESSION_KEYS.category, null);
            writeSessionId(SESSION_KEYS.note, null);
            this.sharesMode = true;
            this.loading.shares = true;
            try {
                this.myShares = await fetchMyShares();
            } finally {
                this.loading.shares = false;
            }
        },

        /**
         * 退出我的分享模式
         */
        exitSharesMode() {
            this.sharesMode = false;
            this.myShares = [];
        },

        // ==================== 静默刷新（tab 后台轮询用） ====================

        /**
         * 静默刷新笔记本树（不触发 loading，不写 sessionStorage）
         * 后台轮询用，刷新后校验当前选中的 notebook/category/note 是否仍有效
         */
        async silentRefreshTree() {
            try {
                const tree = await notebookApi.fetchNotebookList();
                this.notebookTree = tree;

                // 校验选中的顶层笔记本是否仍存在于新树中
                if (this.activeNotebookId !== null) {
                    const nbValid = !!findNodeById(tree, this.activeNotebookId);
                    if (!nbValid) {
                        this.activeNotebookId = null;
                        this.activeCategoryId = null;
                        this.activeNoteId = null;
                        this.activeNoteData = null;
                        // 不写 sessionStorage —— 仅静默清空内存状态
                        return;
                    }
                } else if (tree.length > 0) {
                    // 之前无选中，自动选第一个
                    this.activeNotebookId = tree[0].id;
                }

                // 校验选中的分类是否仍有效
                if (this.activeCategoryId !== null) {
                    const catValid = !!findNodeById(tree, this.activeCategoryId);
                    if (!catValid) {
                        this.activeCategoryId = null;
                        this.activeNoteId = null;
                        this.activeNoteData = null;
                        return;
                    }
                }

                // 校验选中的笔记是否仍有效（只做浅层校验：当前分类缓存中有无该笔记）
                if (this.activeNoteId !== null) {
                    const noteInCache = this.noteMap.get(this.activeNoteId);
                    if (!noteInCache && !this.activeNoteData) {
                        this.activeNoteId = null;
                        this.activeNoteData = null;
                    }
                }
            } catch {
                // 静默失败，不影响用户操作
            }
        },

        /**
         * 静默刷新当前分类的笔记列表（不触发 loading）
         * 仅在已加载的分类上重新拉取，跳过未加载的分类
         */
        async silentRefreshCategoryNotes() {
            if (this.activeCategoryId === null) return;
            if (!this.loadedCategoryIds.has(this.activeCategoryId)) return;
            try {
                const notes = await noteApi.fetchNoteList(this.activeCategoryId);
                this.notesByCategory = { ...this.notesByCategory, [this.activeCategoryId]: notes };
            } catch {
                // 静默失败
            }
        },

        /**
         * 静默刷新激活笔记的详细数据（不触发 loading）
         * 同步更新 activeNoteData 和各分类缓存中的对应笔记
         */
        async silentRefreshActiveNote() {
            if (this.activeNoteId === null) return;
            try {
                const note = await fetchNoteById(this.activeNoteId);
                if (!note) return;
                if (this.activeNoteId === note.id) {
                    this.activeNoteData = note;
                }
                // 同步更新分类缓存
                for (const cid of Object.keys(this.notesByCategory)) {
                    const list = this.notesByCategory[Number(cid)];
                    const idx = list.findIndex((n) => n.id === note.id);
                    if (idx !== -1) {
                        list[idx] = note;
                        this.notesByCategory = { ...this.notesByCategory };
                        break;
                    }
                }
            } catch {
                // 静默失败
            }
        },
    },
});
