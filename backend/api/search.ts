import { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { checkNotebookOwnership } from "@/utils/ownership";

/** 搜索结果行类型 */
type SearchNoteRow = {
    id: number;
    notebook_id: number;
    title: string;
    content: string;
    is_pinned: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
};

/**
 * 笔记全文搜索（FTS5 + trigram 分词）
 *
 * 请求参数（Query）：
 *   - notebook_id  必传，顶层笔记本 ID（搜索该笔记本下所有子分类的笔记）
 *   - keyword      必传，关键词，最小长度 2 字符
 *                  （>= 3 走 FTS5 trigram；= 2 走 LIKE 兜底，因 trigram 无法匹配短于 3 字）
 *
 * 搜索范围：指定笔记本下的所有子孙分类的笔记（忽略分类层级）
 * 返回：匹配的笔记列表（按 FTS5 BM25 相关性排序），最多 50 条
 */
export const searchNotes = async (c: Context) => {
    const uid = Number(c.get("uid"));
    const notebookId = Number(c.req.query("notebook_id"));
    const keyword = (c.req.query("keyword") || "").trim();

    // 校验 notebook_id
    if (!notebookId || isNaN(notebookId)) {
        return c.json({
            code: -1000,
            msg: "search.notebook_required",
            data: null,
        });
    }

    // 校验关键词非空且长度 >= 2
    if (!keyword || keyword.length < 2) {
        return c.json({
            code: -1000,
            msg: "search.keyword_too_short",
            data: null,
        });
    }

    // 校验笔记本属于当前用户
    const notebookExists = await checkNotebookOwnership(notebookId, uid);
    if (!notebookExists) {
        return c.json({
            code: -1000,
            msg: "search.notebook_not_found",
            data: null,
        });
    }

    // 递归 CTE：收集顶层笔记本下所有子孙分类 id
    const categoryTreeCte = sql`
        WITH RECURSIVE category_tree(id) AS (
            SELECT id FROM notebooks WHERE id = ${notebookId} AND user_id = ${uid}
            UNION ALL
            SELECT n.id FROM notebooks n
            JOIN category_tree ct ON n.parent_id = ct.id
            WHERE n.user_id = ${uid}
        )
    `;

    let results: SearchNoteRow[];

    if (keyword.length < 3) {
        // trigram 分词无法匹配短于 3 字，改用 LIKE 模糊匹配标题/正文
        // 转义 LIKE 通配符，避免用户输入 % / _ 扩大匹配范围
        const likePattern = `%${keyword.replace(/[%_\\]/g, "\\$&")}%`;
        results = await db.all<SearchNoteRow>(sql`
            ${categoryTreeCte}
            SELECT n.id, n.notebook_id, n.title, n.content, n.is_pinned, n.sort_order, n.created_at, n.updated_at
            FROM notes n
            WHERE n.user_id = ${uid}
              AND n.is_deleted = 0
              AND n.notebook_id IN (SELECT id FROM category_tree)
              AND (n.title LIKE ${likePattern} ESCAPE '\\' OR n.content LIKE ${likePattern} ESCAPE '\\')
            ORDER BY n.is_pinned DESC, n.updated_at DESC
            LIMIT 50;
        `);
    } else {
        // FTS5 MATCH 注入防护：将关键词中的双引号转义为 ""，再用双引号整体包裹
        // 例如用户输入 hello"world → MATCH '"hello""world"'，作为短语查询
        const escapedKeyword = `"${keyword.replace(/"/g, '""')}"`;

        // JOIN notes_fts 走 FTS5 倒排索引，按 BM25 相关性排序
        results = await db.all<SearchNoteRow>(sql`
            ${categoryTreeCte}
            SELECT n.id, n.notebook_id, n.title, n.content, n.is_pinned, n.sort_order, n.created_at, n.updated_at
            FROM notes n
            JOIN notes_fts f ON n.id = f.rowid
            WHERE n.user_id = ${uid}
              AND n.is_deleted = 0
              AND n.notebook_id IN (SELECT id FROM category_tree)
              AND notes_fts MATCH ${escapedKeyword}
            ORDER BY rank
            LIMIT 50;
        `);
    }

    return c.json({
        code: 200,
        msg: "search.success",
        data: results,
    });
};
