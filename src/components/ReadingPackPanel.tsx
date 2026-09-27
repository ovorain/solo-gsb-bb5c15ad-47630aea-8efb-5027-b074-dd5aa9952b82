import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../lib/context';
import { shortArticleLabel } from '../lib/labels';
import { formatOrdinal } from '../lib/numeral';
import type { ClauseNode } from '../../shared/model';
import {
  articleHeading,
  isReadingPackStale,
  renderReadingPackText,
  type ReadingPack,
  type ReadingPackWarning,
} from '../lib/readingPack';

/** 把纯文本复制到剪贴板（Clipboard API 不可用时回退到隐藏 textarea） */
async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到兜底方案
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ReadingPackPanel() {
  const { store, highlighter } = useApp();
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  const { analysis, doc, confirmed, readingPacks } = store.getSnapshot();

  const [articleId, setArticleId] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const articles = analysis.articles;
  const selectedExists = Boolean(articleId && analysis.nodes[articleId]);

  const activePack: ReadingPack | null = useMemo(
    () => readingPacks.find((p) => p.id === activeId) ?? null,
    [readingPacks, activeId],
  );

  // 当前选中的包被放弃后，自动取最新生成的包
  useEffect(() => {
    if (!activeId || !readingPacks.some((p) => p.id === activeId)) {
      setActiveId(readingPacks[0]?.id ?? null);
    }
  }, [readingPacks, activeId]);

  const stale = activePack
    ? isReadingPackStale(activePack, doc.updatedAt, confirmed)
    : false;

  const generate = () => {
    if (!articleId || !analysis.nodes[articleId]) return;
    const id = store.generateReadingPack(articleId);
    if (id) {
      setActiveId(id);
      setCopyMsg(null);
    }
  };

  const regenerate = () => {
    if (!activePack) return;
    const rootStillExists = Boolean(analysis.nodes[activePack.rootArticleId]);
    const nextRoot = rootStillExists ? activePack.rootArticleId : articleId;
    if (!nextRoot || !analysis.nodes[nextRoot]) return;
    const id = store.generateReadingPack(nextRoot);
    if (id) {
      setActiveId(id);
      setCopyMsg(null);
    }
  };

  const discard = (id: string) => {
    store.discardReadingPack(id);
  };

  const copyPack = async (pack: ReadingPack) => {
    // 旧结果禁止复制：必须先按最新正文 / 确认重新生成
    if (isReadingPackStale(pack, doc.updatedAt, confirmed)) {
      setCopyMsg({ ok: false, text: '阅读包已过期，请重新生成后再复制' });
      return;
    }
    const ok = await copyPlainText(renderReadingPackText(pack));
    setCopyMsg(
      ok
        ? { ok: true, text: '已复制纯文本阅读包' }
        : { ok: false, text: '复制失败，请检查浏览器剪贴板权限' },
    );
  };

  return (
    <div className="reading-panel">
      <div className="reading-builder">
        <div className="reading-builder-head">
          <span className="impact-title">引用阅读包</span>
          <span className="reading-builder-note">沿引用方向收集直接 / 间接依赖条款</span>
        </div>
        <div className="sandbox-form">
          <select
            className="impact-select"
            value={selectedExists ? articleId : ''}
            onChange={(e) => setArticleId(e.target.value)}
            aria-label="选择阅读包起点条款"
          >
            <option value="">选择条款…</option>
            {articles.map((a) => (
              <option key={a.id} value={a.id}>
                {shortArticleLabel(a.ordinal, a.suffix)}
                {a.title ? ` ${a.title}` : ''}
              </option>
            ))}
          </select>
          <button className="primary small" onClick={generate} disabled={!selectedExists}>
            生成阅读包
          </button>
        </div>
        <div className="impact-hint">
          选定一条后，按当前已确认的引用关系逐层收集它直接及间接引用的条款（组合引用的每个已解析目标都参与）；
          循环与多路径汇合只收录一次，按原文档顺序完整展示条、款、项原文，不改写原文。
        </div>

        {readingPacks.length > 0 && (
          <div className="reading-history">
            {readingPacks.map((p) => {
              const root = analysis.nodes[p.rootArticleId];
              const pStale = isReadingPackStale(p, doc.updatedAt, confirmed);
              return (
                <div
                  key={p.id}
                  className={`reading-chip ${activePack?.id === p.id ? 'active' : ''}`}
                >
                  <button
                    className="reading-chip-main"
                    title={activePack?.id === p.id ? '当前查看的阅读包' : '查看该阅读包'}
                    onClick={() => {
                      setActiveId(p.id);
                      setCopyMsg(null);
                    }}
                  >
                    <strong>
                      {root
                        ? shortArticleLabel(root.ordinal, root.suffix)
                        : '（起点已删除）'}
                    </strong>
                    <span className="reading-chip-meta">
                      {p.entries.length} 条
                      {p.warnings.length > 0 ? ` · ${p.warnings.length} 处断链/歧义` : ''}
                      {pStale ? ' · 已过期' : ''}
                    </span>
                  </button>
                  <button
                    className="danger small"
                    title="放弃该阅读包（不影响正文）"
                    onClick={() => discard(p.id)}
                  >
                    删除
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {activePack ? (
        <ReadingPackView
          pack={activePack}
          stale={stale}
          copyMsg={copyMsg}
          onCopy={() => void copyPack(activePack)}
          onRegenerate={regenerate}
          onJumpArticle={(id) => highlighter.jumpTo(id)}
          onJumpWarning={(w) => {
            if (stale) return;
            highlighter.jumpTo(
              w.sourceNodeId,
              { start: w.sentenceStart, end: w.sentenceEnd },
              w.key,
            );
          }}
        />
      ) : (
        <div className="impact-hint reading-empty">
          尚未生成阅读包。选择起点条款后点「生成阅读包」；结果仅用于当前会话，不修改正文、不写入撤销历史。
        </div>
      )}

      <div className="panel-footer">
        阅读包为生成时刻的原文快照；正文或歧义确认变化后自动标记过期，需重新生成方可复制。点击条款标题或警示行可跳回正文。
      </div>
    </div>
  );
}

function ReadingPackView({
  pack,
  stale,
  copyMsg,
  onCopy,
  onRegenerate,
  onJumpArticle,
  onJumpWarning,
}: {
  pack: ReadingPack;
  stale: boolean;
  copyMsg: { ok: boolean; text: string } | null;
  onCopy: () => void;
  onRegenerate: () => void;
  onJumpArticle: (articleId: string) => void;
  onJumpWarning: (w: ReadingPackWarning) => void;
}) {
  const byId = useMemo(() => new Map(pack.articles.map((a) => [a.id, a])), [pack.articles]);
  const root = byId.get(pack.rootArticleId);
  const frozenRootExists = Boolean(root);

  return (
    <div className="reading-result">
      <div className="reading-result-head">
        <div className="reading-result-title">
          起点：{root ? articleHeading(root) : '（起点条款已删除）'}
        </div>
        <div className="reading-result-actions">
          <button className="small" onClick={onCopy} disabled={stale} title={stale ? '旧结果已过期，重新生成后才能复制' : '复制整份阅读包为纯文本'}>
            📋 复制纯文本
          </button>
          <button className="small" onClick={onRegenerate} disabled={!frozenRootExists} title="按最新正文与歧义确认重新生成">
            ↻ 重新生成
          </button>
        </div>
      </div>

      <div className="reading-summary">
        收录 <strong>{pack.entries.length}</strong> 条（含起点，按原文档顺序）·
        最远第{formatOrdinal(Math.max(pack.maxDistance, 1))}层
        {pack.dedupedPaths > 0 && (
          <span className="reading-dedupe"> · 循环 / 汇合路径已去重 {pack.dedupedPaths} 条</span>
        )}
      </div>

      {stale && (
        <div className="impact-stale">
          正文或歧义确认已变化，以下为生成于旧版本的摘录，不能作为当前依据、也不能复制；
          <button className="link-btn" onClick={onRegenerate} disabled={!frozenRootExists}>
            立即重新生成
          </button>
          {!frozenRootExists && '（起点条款已删除，请重新选择起点）'}
        </div>
      )}

      {copyMsg && (
        <div className={`reading-copy-msg ${copyMsg.ok ? 'is-ok' : 'is-err'}`}>{copyMsg.text}</div>
      )}

      <div className="reading-articles">
        {pack.entries.map((entry) => {
          const article = byId.get(entry.articleId);
          if (!article) return null;
          return (
            <ReadingArticleCard
              key={entry.articleId}
              article={article}
              distance={entry.distance}
              inCycle={entry.inCycle}
              stale={stale}
              onJump={() => onJumpArticle(entry.articleId)}
            />
          );
        })}
      </div>

      <div className="reading-warnings">
        <div className="reading-warnings-head">
          断链 / 歧义引用（{pack.warnings.length} 处）
        </div>
        {pack.warnings.length === 0 ? (
          <div className="impact-hint">收录条款中没有断链或未确认的歧义引用，摘录范围内引用均可定位。</div>
        ) : (
          <div className="reading-warning-list">
            <div className="reading-warnings-note">
              以下引用未解析为确定目标，上文摘录并非自足，援引前请先核对原文：
            </div>
            {pack.warnings.map((w) => {
              const source = byId.get(w.sourceArticleId);
              return (
                <button
                  key={w.key}
                  className={`reading-warning-row ${w.kind === 'broken' ? 'is-broken' : 'is-ambiguous'}`}
                  disabled={stale}
                  onClick={() => onJumpWarning(w)}
                  title={stale ? '阅读包已过期，请重新生成后再跳转' : '点击跳回正文源句'}
                >
                  <span className="reading-warning-tag">
                    {w.kind === 'broken' ? '⛓ 断链' : '❓ 歧义'}
                  </span>
                  <span className="reading-warning-source">
                    {source ? shortArticleLabel(source.ordinal, source.suffix) : '（来源条）'}
                  </span>
                  <span className="reading-warning-raw">“{w.raw}”</span>
                  <span className="reading-warning-reason">{w.reason}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="impact-note">
        阅读包仅用于当前会话，不修改正文、不写入撤销历史、不持久化；内容保留原编号与原文。
      </div>
    </div>
  );
}

function ReadingArticleCard({
  article,
  distance,
  inCycle,
  stale,
  onJump,
}: {
  article: ClauseNode;
  distance: number;
  inCycle: boolean;
  stale: boolean;
  onJump: () => void;
}) {
  const tag =
    distance === 0
      ? '起点'
      : `第${formatOrdinal(distance)}层 · ${distance === 1 ? '直接依赖' : '间接依赖'}`;
  return (
    <div className={`reading-article ${distance === 0 ? 'is-root' : ''}`}>
      <button
        className="reading-article-head"
        disabled={stale}
        onClick={onJump}
        title={stale ? '阅读包已过期，请重新生成后再跳转' : '点击跳回正文该条'}
      >
        <span className="reading-article-number">{articleHeading(article)}</span>
        <span className={`reading-layer-tag ${distance === 0 ? 'is-root-tag' : ''}`}>{tag}</span>
        {inCycle && <span className="impact-cycle-badge">↻ 循环</span>}
      </button>
      <div className="reading-article-body">
        {article.text && <p className="reading-line reading-article-headtext">{article.text}</p>}
        {article.children.map((paragraph, pi) => (
          <div className="reading-paragraph" key={paragraph.id}>
            <p className="reading-line">
              <span className="reading-sub-number">第{formatOrdinal(pi + 1)}款</span>
              {paragraph.text}
            </p>
            {paragraph.children.length > 0 && (
              <div className="reading-items">
                {paragraph.children.map((item, ii) => (
                  <p className="reading-line reading-item" key={item.id}>
                    <span className="reading-sub-number reading-item-number">
                      （{formatOrdinal(ii + 1)}）
                    </span>
                    {item.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
