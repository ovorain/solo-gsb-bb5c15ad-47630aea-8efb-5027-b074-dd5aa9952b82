import type { Analysis, ClauseNode, RefOccurrence } from '../../shared/model';
import { locateSentence } from './analyzer';
import { formatOrdinal } from './numeral';

/**
 * 引用阅读包：用户选定一条后，沿当前已确认的引用关系向「目标方向」逐层
 * 收集该条直接及间接依赖的条款（条级图前向广度优先遍历）。
 * 组合引用的每个已解析目标都各有一条边，因此都参与收集；
 * 循环与多路径汇合只收录一次，结果整体按原文档顺序展示完整条款及其款、项。
 * 另把收录条款中的断链与未确认歧义引用单列为警示，标明来源、原文与原因，
 * 避免摘录被误认为自足。结果为纯计算 / 只读快照，仅用于当前会话展示，
 * 不修改正文、不写入撤销历史、不持久化、不随 JSON 导出。
 */

export interface ReadingPackEntry {
  articleId: string;
  /** 距起点条款的最短引用距离：0 为起点本身，1 为直接依赖，其余为间接依赖 */
  distance: number;
  /** 该条是否处于引用循环上（循环路径已在分析层检出） */
  inCycle: boolean;
}

export interface ReadingPackWarning {
  /** 稳定 key：直接采用引用出现 key，同一引用天然只收录一次 */
  key: string;
  kind: 'broken' | 'ambiguous';
  /** 引用所在节点 id（款 / 项） */
  sourceNodeId: string;
  /** 引用所在条 id */
  sourceArticleId: string;
  /** 引用原文（保留原文，不改写） */
  raw: string;
  /** 源句在节点正文中的字符区间（生成时刻定位，正文变化后失效不可跳） */
  sentenceStart: number;
  sentenceEnd: number;
  /** 断链原因 / 歧义说明 */
  reason: string;
}

export interface ReadingPack {
  id: string;
  /** 生成时刻（Date.now） */
  createdAt: number;
  /** 起点条 id */
  rootArticleId: string;
  /** 生成时的歧义确认记录签名（确认变化后旧包失效，不能复制旧结果） */
  confirmedSig: string;
  /** 生成时的文档版本（doc.updatedAt；正文或结构变化后旧包失效） */
  docVersion: number;
  /** 收录条款（起点 + 全部依赖），按原文档顺序排列的元数据（distance 供标注） */
  entries: ReadingPackEntry[];
  /** 收录条款正文的只读冻结副本（id/编号/正文与生成时一致，展示与复制均取此副本） */
  articles: ClauseNode[];
  /** 收录条款中的断链 / 未确认歧义引用（按文档顺序） */
  warnings: ReadingPackWarning[];
  /** 遍历中被去重的循环 / 汇合路径条数 */
  dedupedPaths: number;
  /** 最大引用距离（0 表示只有起点） */
  maxDistance: number;
}

/** 歧义确认记录的稳定签名（顺序无关），供旧包失效判定 */
export function confirmedSignature(confirmed: Record<string, string>): string {
  return Object.keys(confirmed)
    .sort()
    .map((k) => `${k}=${confirmed[k]}`)
    .join('|');
}

/** 条的原文编号，如“第五条”“第八条之一”（保留原编号与之一/之二后缀，不改写） */
export function articleNumberLabel(article: ClauseNode): string {
  return `第${formatOrdinal(article.ordinal)}条${article.suffix ? `之${article.suffix}` : ''}`;
}

/** 条标题展示：编号 +【标题】（标题缺失时只显示编号） */
export function articleHeading(article: ClauseNode): string {
  return `${articleNumberLabel(article)}${article.title ? `【${article.title}】` : ''}`;
}

/** 深拷贝收录条款，使阅读包与活动文档完全脱离引用关系（只读冻结） */
function freezeArticles(articles: ClauseNode[]): ClauseNode[] {
  return articles.map((a) => ({
    ...a,
    title: a.title,
    suffix: a.suffix,
    text: a.text,
    children: a.children.map((p) => ({
      ...p,
      title: p.title,
      suffix: p.suffix,
      text: p.text,
      children: p.children.map((it) => ({
        ...it,
        title: it.title,
        suffix: it.suffix,
        text: it.text,
        children: [],
      })),
    })),
  }));
}

/**
 * 以 articleId 为起点生成引用阅读包。
 * - 条级前向图由 analysis.edges 给出（已应用歧义确认；组合引用每个已解析目标各有一条边）；
 * - 广度优先遍历，每条只按最短距离收录一次，循环回指与多路径汇合计入 dedupedPaths；
 * - 条内自指边（sourceArticleId === targetArticleId）不构成条款间依赖路径。
 */
export function buildReadingPack(
  analysis: Analysis,
  rootArticleId: string,
  confirmed: Record<string, string>,
  id: string,
  docVersion: number,
  now: number,
): ReadingPack {
  const order = new Map(analysis.articles.map((a, i) => [a.id, i] as const));

  // 正向邻接：sourceArticleId -> 它引用的目标条集合（条内自指边跳过）
  const outbound = new Map<string, Set<string>>();
  for (const e of analysis.edges) {
    if (e.sourceArticleId === e.targetArticleId) continue;
    let set = outbound.get(e.sourceArticleId);
    if (!set) outbound.set(e.sourceArticleId, (set = new Set()));
    set.add(e.targetArticleId);
  }

  const cycleSet = new Set<string>();
  for (const issue of analysis.issues) {
    if (issue.type !== 'cycle') continue;
    for (const cid of issue.cycleNodeIds ?? []) cycleSet.add(cid);
  }

  const dist = new Map<string, number>([[rootArticleId, 0]]);
  let frontier = [rootArticleId];
  let distance = 0;
  let dedupedPaths = 0;
  let maxDistance = 0;

  while (frontier.length > 0) {
    distance += 1;
    const reached: string[] = [];
    for (const aid of frontier) {
      for (const target of outbound.get(aid) ?? []) {
        if (dist.has(target)) {
          // 指向已收录条款的边：循环回指或多路径汇合，去重只计一次
          dedupedPaths += 1;
          continue;
        }
        dist.set(target, distance);
        reached.push(target);
      }
    }
    if (reached.length === 0) break;
    reached.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    maxDistance = distance;
    frontier = reached;
  }

  // 收录条款按原文档顺序展示
  const collectedIds = new Set(dist.keys());
  const orderedArticles = analysis.articles.filter((a) => collectedIds.has(a.id));
  const entries: ReadingPackEntry[] = orderedArticles.map((a) => ({
    articleId: a.id,
    distance: dist.get(a.id)!,
    inCycle: cycleSet.has(a.id),
  }));

  // 收录条款中的断链 / 未确认歧义引用（已确认的歧义参与收集，不再列为警示）
  const warnings = collectWarnings(analysis, collectedIds);

  return {
    id,
    createdAt: now,
    rootArticleId,
    confirmedSig: confirmedSignature(confirmed),
    docVersion,
    entries,
    articles: freezeArticles(orderedArticles),
    warnings,
    dedupedPaths,
    maxDistance,
  };
}

/**
 * 从分析结果中提取收录条款内的警示引用：
 * - broken：断链（含组合引用中部分目标缺失）；
 * - ambiguous：仍未确认的歧义（resolution.ambiguity 存在表示已确认，不计入）。
 * 同一引用出现只收录一次，按 条序 → 款 / 项序 → 引用偏移 的文档顺序排列。
 */
function collectWarnings(analysis: Analysis, articleIds: Set<string>): ReadingPackWarning[] {
  const result: ReadingPackWarning[] = [];
  for (const article of analysis.articles) {
    if (!articleIds.has(article.id)) continue;
    const occs: RefOccurrence[] = [];
    const pushNode = (node: ClauseNode) => {
      for (const occ of analysis.byNode[node.id] ?? []) occs.push(occ);
      for (const child of node.children) pushNode(child);
    };
    pushNode(article);
    occs.sort((a, b) =>
      a.nodeId === b.nodeId ? a.span.start - b.span.start : compareNodeOrder(analysis, a.nodeId, b.nodeId),
    );
    for (const occ of occs) {
      const kind = warningKind(occ);
      if (!kind) continue;
      const node = analysis.nodes[occ.nodeId];
      if (!node) continue;
      const sentence = locateSentence(node.text, occ.span.start, occ.span.end);
      result.push({
        key: occ.key,
        kind,
        sourceNodeId: occ.nodeId,
        sourceArticleId: article.id,
        raw: occ.span.raw,
        sentenceStart: sentence.start,
        sentenceEnd: sentence.end,
        reason: occ.resolution.reason ?? (kind === 'broken' ? '目标不存在' : '存在多个候选目标'),
      });
    }
  }
  return result;
}

function warningKind(occ: RefOccurrence): ReadingPackWarning['kind'] | null {
  if (occ.resolution.status === 'broken') return 'broken';
  if (occ.resolution.status === 'ambiguous' && !occ.resolution.ambiguity) return 'ambiguous';
  return null;
}

/** 同一条内按 条头 → 款序 → 款内项序 比较节点先后（placement 已含全部位置信息） */
function compareNodeOrder(analysis: Analysis, a: string, b: string): number {
  const pa = analysis.placement[a];
  const pb = analysis.placement[b];
  if (!pa || !pb) return 0;
  if (pa.articleIndex !== pb.articleIndex) return pa.articleIndex - pb.articleIndex;
  if (pa.paragraphIndex !== pb.paragraphIndex) return pa.paragraphIndex - pb.paragraphIndex;
  return pa.itemIndex - pb.itemIndex;
}

/**
 * 旧包失效判定：正文 / 结构变化（doc.updatedAt 不同）或歧义确认记录变化后，
 * 阅读包即过期，界面必须要求重新生成，不能复制旧结果。
 */
export function isReadingPackStale(pack: ReadingPack, docVersion: number, confirmed: Record<string, string>): boolean {
  return pack.docVersion !== docVersion || pack.confirmedSig !== confirmedSignature(confirmed);
}

// ---------- 纯文本渲染（一键复制）：保留原编号与正文，不改写原文 ----------

/**
 * 渲染整份阅读包为纯文本：
 * 头部说明起点与收录数，正文按原文档顺序逐条款完整摘录，
 * 末尾单列断链 / 歧义警示，标明来源、原文与原因。
 */
export function renderReadingPackText(pack: ReadingPack): string {
  const byId = new Map(pack.articles.map((a) => [a.id, a]));
  const root = byId.get(pack.rootArticleId);
  const head: string[] = [
    '【引用阅读包】',
    `起点：${root ? articleHeading(root) : '（已删除的条款）'}`,
    `收录条款：${pack.entries.length} 条（含起点；按原文档顺序）｜最远引用距离：第${formatOrdinal(
      Math.max(pack.maxDistance, 1),
    )}层`,
    '以下为生成时刻的原文摘录，保留原编号与正文，未作任何改写；如正文中的引用发生变化，应以重新生成的阅读包为准。',
  ];

  const body = pack.entries.map((entry) => {
    const article = byId.get(entry.articleId);
    if (!article) return '';
    const tag =
      entry.distance === 0
        ? '起点'
        : `第${formatOrdinal(entry.distance)}层 · ${entry.distance === 1 ? '直接依赖' : '间接依赖'}`;
    return `${articleHeading(article)}（${tag}）\n${renderArticleBody(article)}`;
  });

  const parts = [head.join('\n'), '', body.filter(Boolean).join('\n\n')];

  if (pack.warnings.length > 0) {
    parts.push('');
    parts.push(
      `【断链 / 歧义引用警示】（${pack.warnings.length} 处）以下引用在收录条款中未能解析为确定目标，上文摘录并非自足，援引前请先核对原文：`,
    );
    for (const w of pack.warnings) {
      const article = byId.get(w.sourceArticleId);
      const source = article ? articleNumberLabel(article) : '（来源条已不在包内）';
      const tag = w.kind === 'broken' ? '断链' : '歧义（未确认）';
      parts.push(`- [${tag}] 来源 ${source}｜原文“${w.raw}”｜原因：${w.reason}`);
    }
  }

  if (pack.dedupedPaths > 0) {
    parts.push('');
    parts.push(`注：遍历中已对 ${pack.dedupedPaths} 条循环 / 多路径汇合去重，同一条款只收录一次。`);
  }

  return parts.join('\n');
}

/** 条正文（不含条标题行）：条头文字 + 各款 / 项原文 */
function renderArticleBody(article: ClauseNode): string {
  const lines: string[] = [];
  if (article.text.trim()) lines.push(article.text);
  article.children.forEach((paragraph, pi) => {
    lines.push(`第${formatOrdinal(pi + 1)}款　${paragraph.text}`);
    paragraph.children.forEach((item, ii) => {
      lines.push(`　（${formatOrdinal(ii + 1)}）${item.text}`);
    });
  });
  return lines.join('\n');
}
