<script setup lang="ts">
/**
 * 第二栏：笔记列表
 *
 * 顶部：搜索框（FTS5 全文搜索，防抖 300ms）+ 新建笔记按钮
 * 主体：笔记卡片列表（来自 store.displayedNotes）
 *   - 正常态：当前分类下的笔记，可拖拽排序
 *   - 搜索态：跨分类搜索结果，不可拖拽，显示分类名
 * 空态：友好提示
 *
 * 搜索逻辑：
 *   - 关键词 >= 2 字符：防抖 300ms 后调后端搜索
 *   - 关键词 < 2 字符 / 清空 / ESC：退出搜索态，恢复分类列表
 *
 * 右键笔记项可弹出 NoteContextMenu 菜单，调用 store action
 * 完成移入回收站 / 置顶笔记（智能切换），列表自动刷新。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { NButton, NInput, NSpin, useMessage } from "naive-ui";
import { VueDraggable } from "vue-draggable-plus";
import { useI18n } from "vue-i18n";
import ZIcon from "@/components/DynamicIcon.vue";
import NoteListItem from "@/components/note/NoteListItem.vue";
import NoteContextMenu, { type NoteContextAction } from "@/components/note/NoteContextMenu.vue";
import MoveDialog from "@/components/note/dialogs/MoveDialog.vue";
import ShareDialog from "@/components/note/dialogs/ShareDialog.vue";
import { useNoteStore } from "@/stores/note";
import type { Note } from "@/types/note";

const { t } = useI18n();
const message = useMessage();
const noteStore = useNoteStore();

const props = defineProps<{
    notes: Note[];
    activeId: number | null;
    loading: boolean;
    /** 是否禁用"新建笔记"按钮（如未选中分类时） */
    disabledCreate?: boolean;
    /** 是否为回收站模式（隐藏工具栏、禁用拖拽、显示专用空态） */
    trashMode?: boolean;
    /** 是否为移动端视口 */
    isMobile: boolean;
}>();

const emit = defineEmits<{
    (e: "select", id: number): void;
    (e: "create"): void;
}>();

/** 搜索关键词（双向绑定 NInput） */
const keyword = ref(noteStore.searchKeyword);

/**
 * 本地笔记列表（可被 VueDraggable 直接 mutate）
 * 通过 watch 与 props.notes 保持同步，拖拽完成后用后端返回数据覆盖
 */
const localNotes = ref<Note[]>([]);

watch(
    () => props.notes,
    (newNotes) => {
        localNotes.value = [...newNotes];
    },
    { immediate: true },
);

/** 是否处于搜索态（来自 store） */
const isSearchMode = computed(() => noteStore.searchMode);

/** 搜索加载中 */
const isSearching = computed(() => noteStore.loading.search);

/** 搜索结果条数 */
const searchCount = computed(() => noteStore.searchResults.length);

/**
 * 是否允许拖拽排序
 * 条件：非搜索态 + 列表非空
 */
const canDrag = computed(() => {
    if (isSearchMode.value) return false;
    if (props.trashMode) return false;
    return localNotes.value.length > 0;
});

// ==================== 搜索防抖 ====================

/** 防抖定时器引用 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 关键词变化时触发搜索（防抖 300ms）
 * - 关键词 >= 2 字符：调后端搜索
 * - 关键词 < 2 字符：退出搜索态，恢复分类列表
 */
watch(keyword, (val) => {
    const kw = val.trim();
    // 清除上一次防抖
    if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }
    // 关键词不足 2 字符：退出搜索态
    if (kw.length < 2) {
        if (noteStore.searchMode) {
            noteStore.clearSearch();
        }
        return;
    }
    // 防抖 300ms 后调后端搜索
    searchTimer = setTimeout(() => {
        noteStore.searchNotes(kw);
    }, 300);
});

/** 组件卸载时清理防抖定时器 */
onBeforeUnmount(() => {
    if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }
});

/**
 * ESC 键清空搜索关键词，退出搜索态
 */
const handleKeydownEsc = () => {
    keyword.value = "";
    noteStore.clearSearch();
};

/**
 * 拖拽结束回调
 * VueDraggable 已将新顺序写入 localNotes，据此构建 items 调用后端排序接口
 * 用后端返回的列表覆盖本地缓存，保证与服务端排序口径一致（置顶优先等）
 */
const onDragEnd = async () => {
    const items = localNotes.value.map((n, idx) => ({
        id: n.id,
        sort_order: idx,
    }));
    const result = await noteStore.sortNotes(items);
    if (result) {
        message.success(t("note.sort.success"));
    } else {
        // 排序失败：回退本地顺序
        localNotes.value = [...props.notes];
        message.error(t("note.sort.failed"));
    }
};

// ==================== 右键菜单状态 ====================

/** 菜单是否显示 */
const menuShow = ref(false);
/** 菜单横坐标 */
const menuX = ref(0);
/** 菜单纵坐标 */
const menuY = ref(0);
/** 当前右键的笔记 */
const menuNote = ref<Note | null>(null);

// ==================== 移动弹窗状态 ====================

/** 移动弹窗显隐 */
const showMoveDialog = ref(false);
/** 被移动的笔记 */
const moveNote = ref<Note | null>(null);

// ==================== 分享弹窗状态 ====================

/** 分享弹窗显隐 */
const shareDialogShow = ref(false);
/** 被分享的笔记 ID */
const shareNoteId = ref(0);
/** 被分享的笔记标题 */
const shareNoteTitle = ref("");

/** 当前笔记本下的分类树（用于移动对话框） */
const currentCategoryTree = computed(() => {
    return noteStore.activeNotebook?.children ?? [];
});

/** 右键笔记项时：记录坐标并打开菜单 */
const handleContextMenu = (note: Note, e: MouseEvent) => {
    menuNote.value = note;
    menuX.value = e.clientX;
    menuY.value = e.clientY;
    menuShow.value = true;
};

/**
 * 菜单选中操作时：调用对应 store action
 * - trash：软删除后从本地缓存移除，store 内部已处理选中态清空
 * - pin：智能切换 is_pinned 0/1，更新后本地缓存自动同步
 */
const handleMenuSelect = async (action: NoteContextAction, note: Note) => {
    if (action === "open_new_window") {
        window.open(`/app/note/${note.id}`, "_blank");
        return;
    }
    if (action === "trash") {
        await noteStore.deleteNote(note.id);
        message.success(t("note.context.trash.success"));
        return;
    }
    if (action === "permanent_delete") {
        await noteStore.permanentDeleteNote(note.id);
        message.success(t("note.context.permanent_delete.success"));
        return;
    }
    if (action === "move") {
        moveNote.value = note;
        showMoveDialog.value = true;
        return;
    }
    if (action === "share") {
        shareNoteId.value = note.id;
        shareNoteTitle.value = note.title;
        shareDialogShow.value = true;
        return;
    }
    if (action === "disable_vectorize") {
        await noteStore.updateNote(note.id, { allow_vectorize: 0 }, false);
        message.success(t("note.context.disable_vectorize.success"));
        return;
    }
    if (action === "enable_vectorize") {
        await noteStore.updateNote(note.id, { allow_vectorize: 1 }, false);
        message.success(t("note.context.enable_vectorize.success"));
        return;
    }
    // pin：智能切换置顶状态
    const next = note.is_pinned === 1 ? 0 : 1;
    await noteStore.updateNote(note.id, { is_pinned: next });
    message.success(next === 1 ? t("note.context.pin.success") : t("note.context.unpin.success"));
};

/** 确认移动笔记 */
const handleMoveConfirm = async (targetId: number) => {
    if (!moveNote.value) return;
    await noteStore.moveNote(moveNote.value.id, targetId);
    message.success(t("note.move.success"));
    showMoveDialog.value = false;
};

/** 取消移动 */
const handleMoveCancel = () => {
    showMoveDialog.value = false;
};
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶部工具栏：搜索 + 新建（回收站模式隐藏） -->
    <div v-if="!trashMode" class="flex shrink-0 items-center gap-2 border-b border-slate-200/60 bg-white px-3 py-3 md:py-2.5">
      <NInput
        v-model:value="keyword"
        :size="props.isMobile ? 'large' : 'medium'"
        :placeholder="t('note.note.search.placeholder')"
        clearable
        @keydown.escape="handleKeydownEsc"
      >
        <template #prefix>
          <ZIcon name="ri:search-line" :size="props.isMobile ? 16 : 14" color="#94a3b8" />
        </template>
      </NInput>
      <NButton
        type="primary"
        :size="props.isMobile ? 'large' : 'medium'"
        :disabled="disabledCreate || isSearchMode"
        @click="emit('create')"
      >
        <template #icon>
          <ZIcon name="ri:add-line" :size="props.isMobile ? 16 : 14" color="currentColor" />
        </template>
        <span class="hidden sm:inline">{{ t("note.note.create.button") }}</span>
      </NButton>
    </div>

    <!-- 列表主体 -->
    <div class="flex-1 overflow-y-auto bg-[#f7f8fa] p-3">
      <NSpin v-if="loading || isSearching" class="block py-12" />

      <!-- 搜索态：标题栏 + 搜索结果列表/空态 -->
      <template v-else-if="isSearchMode">
        <!-- 搜索结果标题栏 -->
        <div class="mb-2 flex items-center gap-1.5 border-b border-slate-200/60 pb-2 text-xs text-slate-500">
          <ZIcon name="ri:search-line" :size="12" color="#94a3b8" />
          <span>{{ t("note.note.search.results") }}</span>
          <span class="text-slate-400">({{ searchCount }})</span>
        </div>

        <!-- 搜索结果列表 -->
        <div v-if="localNotes.length > 0" class="space-y-2">
          <NoteListItem
            v-for="note in localNotes"
            :key="note.id"
            :note="note"
            :active="activeId === note.id"
            :category-name="noteStore.getCategoryName(note.notebook_id)"
            :is-mobile="props.isMobile"
            @select="(id: number) => emit('select', id)"
            @contextmenu="handleContextMenu"
          />
        </div>

        <!-- 搜索无结果空态 -->
        <div v-else class="flex h-full flex-col items-center justify-center gap-3 py-16 text-center">
          <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
            <ZIcon name="ri:sticky-note-line" :size="28" color="#94a3b8" />
          </div>
          <div>
            <p class="text-sm font-medium text-slate-600">{{ t("note.note.search.no_results") }}</p>
          </div>
        </div>
      </template>

      <!-- 可拖拽列表：非搜索态 + 同分类时启用 -->
      <VueDraggable
        v-else-if="canDrag && localNotes.length > 0"
        v-model="localNotes"
        class="space-y-2"
        :animation="150"
        :handle="'.drag-handle'"
        :disabled="noteStore.loading.save"
        @end="onDragEnd"
      >
        <NoteListItem
          v-for="note in localNotes"
          :key="note.id"
          :note="note"
          :active="activeId === note.id"
          :draggable="!note.is_pinned"
          :is-mobile="props.isMobile"
          @select="(id: number) => emit('select', id)"
          @contextmenu="handleContextMenu"
        />
      </VueDraggable>

      <!-- 普通列表（不可拖拽） -->
      <div v-else-if="localNotes.length > 0" class="space-y-2">
        <NoteListItem
          v-for="note in localNotes"
          :key="note.id"
          :note="note"
          :active="activeId === note.id"
          :is-mobile="props.isMobile"
          @select="(id: number) => emit('select', id)"
          @contextmenu="handleContextMenu"
        />
      </div>

      <!-- 空态 -->
      <div
        v-else
        class="flex h-full flex-col items-center justify-center gap-3 py-16 text-center"
      >
        <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
          <ZIcon :name="trashMode ? 'ri:delete-bin-line' : 'ri:sticky-note-line'" :size="28" color="#94a3b8" />
        </div>
        <div>
          <p class="text-sm font-medium text-slate-600">{{ trashMode ? t('note.trash.empty') : t('note.note.empty.title') }}</p>
          <p v-if="!trashMode" class="mt-1 text-xs text-slate-400">{{ t('note.note.empty.desc') }}</p>
        </div>
      </div>
    </div>

    <!-- 笔记右键菜单：通过 manual 触发 + x/y 定位 -->
    <NoteContextMenu
      v-model:show="menuShow"
      :x="menuX"
      :y="menuY"
      :note="menuNote"
      @select="handleMenuSelect"
    />

    <!-- 移动笔记弹窗 -->
    <MoveDialog
      v-model:show="showMoveDialog"
      type="note"
      :source-id="moveNote?.id ?? 0"
      :source-name="moveNote?.title ?? ''"
      :notebook-tree="currentCategoryTree"
      :current-category-id="noteStore.activeCategoryId ?? undefined"
      @confirm="handleMoveConfirm"
      @cancel="handleMoveCancel"
    />

    <!-- 创建分享弹窗 -->
    <ShareDialog
      v-model:show="shareDialogShow"
      :note-id="shareNoteId"
      :note-title="shareNoteTitle"
    />
  </div>
</template>
