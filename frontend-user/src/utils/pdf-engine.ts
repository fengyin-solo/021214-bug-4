/**
 * PDF 渲染引擎 — 基于 PDF.js 2.10.377
 * PDF.js 通过 index.html 中的 <script> 标签加载到 window.pdfjsLib
 * 2.x UMD 版本无 private class fields，彻底避免 Vite 兼容性问题
 */

/* ------------------------------------------------------------------ */
/*  PDF.js 2.x 类型定义（无需 @types/pdfjs-dist，手动声明核心接口）       */
/* ------------------------------------------------------------------ */

/** PDF.js Viewport（getViewport 返回值） */
export interface PdfjsViewport {
  width: number
  height: number
  scale: number
  rotation: number
  transform: number[]
  clone(params?: { scale?: number; rotation?: number; dontFlip?: boolean }): PdfjsViewport
}

/** PDF.js 单页对象 */
export interface PdfjsPage {
  pageNumber: number
  getViewport(params: { scale: number; rotation?: number }): PdfjsViewport
  getTextContent(): Promise<PdfjsTextContent>
  getAnnotations(): Promise<PdfjsAnnotation[]>
  render(params: { canvasContext: CanvasRenderingContext2D; viewport: PdfjsViewport }): { promise: Promise<void> }
}

/** PDF.js 文档对象 */
export interface PdfjsDocument {
  numPages: number
  getPage(pageNumber: number): Promise<PdfjsPage>
  destroy(): void
}

/** PDF.js TextContent */
export interface PdfjsTextContent {
  items: Array<{
    str: string
    dir: string
    transform: number[]
    width: number
    height: number
    hasEOL?: boolean
    fontName?: string
  }>
  styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }>
}

/** PDF.js Annotation（简化） */
export interface PdfjsAnnotation {
  annotationType: number
  id: string
  rect: number[]
  url?: string
  dest?: string | unknown[]
}

/** 匹配命中的文本项片段（命中可能跨越多个被拆开的文本项） */
export interface MatchPart {
  /** 对应非空文本项在整页中的序号（与 Text Layer 中实际渲染的 span 逐一对应） */
  itemIndex: number
  /** 片段在该文本项字符串内的起止位置（按字符计） */
  charStart: number
  charEnd: number
}

/** 单个搜索匹配结果 */
export interface SearchMatch {
  pageNumber: number
  matchIndex: number
  /** 实际命中的文字（逻辑页面文字中的原样内容） */
  text: string
  /** 在逻辑页面文字中的起止偏移，侧栏据此截取上下文片段 */
  startOffset: number
  endOffset: number
  /** 命中起始处在页面 CSS 坐标（scale=1）中的 y 值，用于跳转定位 */
  top: number
  /** 命中跨越的各个文本项片段，用于在 Text Layer 中精确高亮 */
  parts: MatchPart[]
}

/** 单页搜索结果 */
export interface PageSearchResult {
  pageNumber: number
  matches: SearchMatch[]
  pageText: string
}

/** 全文搜索结果 */
export interface SearchResult {
  keyword: string
  totalMatches: number
  totalPages: number
  pages: PageSearchResult[]
}

/** PDF.js 链接服务接口 */
interface PdfjsLinkService {
  getDestinationHash: (dest: string) => string
  getAnchorUrl: (hash: string) => string
  addLinkAttributes: (link: HTMLAnchorElement, url: string) => void
  externalLinkEnabled: boolean
  externalLinkRel: string
  externalLinkTarget: number
  isInPresentationMode: boolean
}

declare global {
  interface Window {
    pdfjsLib?: {
      GlobalWorkerOptions: { workerSrc: string }
      getDocument(params: Record<string, unknown>): { promise: Promise<PdfjsDocument> }
      renderTextLayer(params: {
        textContent: PdfjsTextContent
        container: HTMLDivElement
        viewport: PdfjsViewport
        enhanceTextSelection?: boolean
      }): { promise: Promise<void>; cancel(): void }
      AnnotationLayer: {
        render(params: {
          annotations: PdfjsAnnotation[]
          div: HTMLDivElement
          page: PdfjsPage
          viewport: PdfjsViewport
          linkService: PdfjsLinkService
        }): void
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  初始化                                                              */
/* ------------------------------------------------------------------ */

let _resolve: () => void
const pdfjsReady = new Promise<void>((resolve) => {
  _resolve = resolve
})

if (window.pdfjsLib) {
  _resolve!()
} else {
  window.addEventListener('pdfjs-ready', () => _resolve(), { once: true })
}

function getPdfjs() {
  const lib = window.pdfjsLib
  if (!lib) throw new Error('PDF.js not loaded')
  return lib
}

async function ensureReady() {
  await pdfjsReady
  return getPdfjs()
}

/* ------------------------------------------------------------------ */
/*  导出接口                                                            */
/* ------------------------------------------------------------------ */

export interface PageRenderResult {
  page: PdfjsPage
  pageNumber: number
  viewport: PdfjsViewport
}

/** 预加载（等待 PDF.js 就绪） */
export async function preloadPdfjs(): Promise<void> {
  await ensureReady()
}

/** 加载 PDF 文档 */
export async function loadPdfDocument(url: string): Promise<PdfjsDocument> {
  const pdfjs = await ensureReady()
  return pdfjs.getDocument({
    url,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
  }).promise
}

/** 渲染单页到 Canvas */
export async function renderPageToCanvas(
  page: PdfjsPage, canvas: HTMLCanvasElement, scale: number,
): Promise<PageRenderResult> {
  const viewport = page.getViewport({ scale })
  const ctx = canvas.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.floor(viewport.width * dpr)
  canvas.height = Math.floor(viewport.height * dpr)
  canvas.style.width = `${viewport.width}px`
  canvas.style.height = `${viewport.height}px`
  ctx.scale(dpr, dpr)
  await page.render({ canvasContext: ctx, viewport }).promise
  return { page, pageNumber: page.pageNumber, viewport }
}

/**
 * 构建 Text Layer — 核心：精确文字定位
 * 2.x API: pdfjsLib.renderTextLayer({ textContent, container, viewport, enhanceTextSelection })
 */
export async function buildTextLayer(
  page: PdfjsPage, container: HTMLDivElement, viewport: PdfjsViewport,
): Promise<void> {
  const pdfjs = getPdfjs()
  const textContent = await page.getTextContent()
  container.innerHTML = ''
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  const task = pdfjs.renderTextLayer({
    textContent,
    container,
    viewport,
    enhanceTextSelection: true,
  })
  return task.promise
}

/**
 * 构建 Annotation Layer
 * 2.x API: AnnotationLayer.render({ annotations, div, page, viewport, linkService })
 */
export async function buildAnnotationLayer(
  page: PdfjsPage, container: HTMLDivElement, viewport: PdfjsViewport,
): Promise<void> {
  const pdfjs = getPdfjs()
  const annotations = await page.getAnnotations()
  if (!annotations.length) return
  container.innerHTML = ''
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  try {
    pdfjs.AnnotationLayer.render({
      annotations,
      div: container,
      page,
      viewport: viewport.clone({ dontFlip: true }),
      linkService: {
        getDestinationHash: () => '#',
        getAnchorUrl: () => '#',
        addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
          link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'
        },
        externalLinkEnabled: true,
        externalLinkRel: 'noopener noreferrer',
        externalLinkTarget: 2,
        isInPresentationMode: false,
      },
    })
  } catch { /* 注释层失败不影响核心功能 */ }
}

/**
 * 获取每页的原始尺寸（未缩放，scale=1）
 * 用于精确预计算不同尺寸页面的布局
 */
export async function getPageBaseDimensions(
  doc: PdfjsDocument,
): Promise<Map<number, { baseWidth: number; baseHeight: number }>> {
  const result = new Map<number, { baseWidth: number; baseHeight: number }>()
  // 并发获取所有页面尺寸，每批 10 页避免过多并发
  const batchSize = 10
  for (let start = 1; start <= doc.numPages; start += batchSize) {
    const end = Math.min(start + batchSize - 1, doc.numPages)
    const promises: Promise<void>[] = []
    for (let i = start; i <= end; i++) {
      promises.push(
        doc.getPage(i).then((page) => {
          const vp = page.getViewport({ scale: 1 })
          result.set(i, { baseWidth: vp.width, baseHeight: vp.height })
        })
      )
    }
    await Promise.all(promises)
  }
  return result
}

/* ------------------------------------------------------------------ */
/*  全文搜索                                                            */
/* ------------------------------------------------------------------ */

/** 页面组装后的一个非空文本项（与 Text Layer 中真正渲染的 span 一一对应） */
interface AssembledItem {
  str: string
  transform: number[]
  /** 该项文字在逻辑页面文字中的起止偏移 */
  startOffset: number
  endOffset: number
}

interface AssembledPageText {
  /** 按读者在页面上看到的连续文字组装出的页面文本 */
  pageText: string
  items: AssembledItem[]
}

/**
 * 获取单页文本，并按视觉排版把被 PDF 拆碎的文本项组装成连续文字。
 *
 * PDF 中同一句话常被拆成多个文本项（甚至一个单词被拆成多段），因此不能在
 * 每个文本项之间机械地插空格，否则同一句关键词在不同文档中命中数会对不上。
 * 这里按 Text Layer 同样的几何规则决定拼接方式：
 * - 文本项自带换行标记（hasEOL）或换到了下一行 → 插入换行；
 * - 同一行、两段之间存在明显空隙（约半个字号以上）→ 插入空格；
 * - 同一行且首尾相接（单词被拆开）→ 直接相连。
 */
export async function getPageTextWithOffsets(
  page: PdfjsPage,
): Promise<AssembledPageText> {
  const textContent = await page.getTextContent()
  const items: AssembledItem[] = []
  const segments: string[] = []
  let fullLength = 0

  let prev: {
    transform: number[]
    endX: number
    fontHeight: number
  } | null = null

  const pushSegment = (s: string) => {
    if (!s) return
    segments.push(s)
    fullLength += s.length
  }

  for (const raw of textContent.items) {
    const str = raw.str ?? ''
    const t = raw.transform
    const isVertical =
      textContent.styles[raw.fontName ?? '']?.vertical === true
    const forceEOL = raw.hasEOL === true

    if (str !== '') {
      if (prev) {
        let separator = ''
        if (!isVertical && prev.fontHeight > 0) {
          const sameLine = Math.abs(t[5] - prev.transform[5]) < prev.fontHeight * 0.5
          if (!sameLine) {
            separator = '\n'
          } else {
            const gap = t[4] - prev.endX
            // 空隙超过约半个字号视为词间空格；否则视为被拆开的同一个词
            separator = gap > prev.fontHeight * 0.5 ? ' ' : ''
          }
        }
        pushSegment(separator)
      }

      const startOffset = fullLength
      pushSegment(str)

      items.push({
        str,
        transform: t,
        startOffset,
        endOffset: fullLength,
      })

      const fontHeight =
        Math.hypot(t[2], t[3]) || Math.abs(t[3]) || Math.abs(t[1])
      prev = forceEOL
        ? null
        : {
            transform: t,
            endX: isVertical ? t[5] - raw.width : t[4] + raw.width,
            fontHeight,
          }
    } else {
      // 空文本项不会渲染出 span，只可能携带换行标记
      prev = null
    }

    if (forceEOL && segments[segments.length - 1] !== '\n') {
      pushSegment('\n')
    }
  }

  return { pageText: segments.join(''), items }
}

/** 任意连续空白（含换行、制表、不间断空格）归一化为单个空格 */
const WHITESPACE_REGEX = /\s+/g

interface NormalizedText {
  /** 归一化后的文本：每个空白序列都变成单个空格 */
  text: string
  /** normToLogical[i] = 归一化文本第 i 个字符在原始逻辑文本中的下标 */
  normToLogical: number[]
}

function normalizeText(input: string): NormalizedText {
  const normToLogical: number[] = []
  let out = ''
  let wsStart = -1

  const flushWhitespace = () => {
    if (wsStart < 0) return
    // 开头的空白会被折叠掉，不产生任何字符
    if (out.length > 0) {
      normToLogical.push(wsStart)
      out += ' '
    }
    wsStart = -1
  }

  for (let i = 0; i < input.length; i++) {
    if (/\s/.test(input[i])) {
      if (wsStart < 0) wsStart = i
    } else {
      flushWhitespace()
      normToLogical.push(i)
      out += input[i]
    }
  }
  // 末尾的空白折叠后不产生字符（等同 trim）
  wsStart = -1

  return { text: out, normToLogical }
}

/**
 * 在单页中搜索关键词，返回所有匹配项。
 * 比较时忽略大小写差异，并把任意空白（含跨行）折叠为单个空格，
 * 因此被拆成多个文本项、甚至横跨换行的同一句话都能完整命中。
 */
export async function searchPage(
  page: PdfjsPage,
  keyword: string,
  caseSensitive = false,
): Promise<PageSearchResult> {
  const { pageText, items } = await getPageTextWithOffsets(page)
  const matches: SearchMatch[] = []

  if (!keyword.trim() || !pageText) {
    return { pageNumber: page.pageNumber, matches, pageText }
  }

  const normPage = normalizeText(pageText)
  const normKeyword = keyword.replace(WHITESPACE_REGEX, ' ').trim()
  const haystack = caseSensitive ? normPage.text : normPage.text.toLowerCase()
  const needle = caseSensitive ? normKeyword : normKeyword.toLowerCase()
  if (!needle) {
    return { pageNumber: page.pageNumber, matches, pageText }
  }

  let from = 0
  let matchIndex = 0
  while (from <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, from)
    if (found === -1) break

    const normStart = found
    const normEnd = found + needle.length
    // 映射回逻辑页面文本中的真实区间
    const startOffset = normPage.normToLogical[normStart]
    const endOffset = (normPage.normToLogical[normEnd - 1] ?? pageText.length - 1) + 1

    // 命中跨越的文本项片段（与 Text Layer 的 span 序号一致）
    const parts: MatchPart[] = []
    for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
      const item = items[itemIdx]
      if (item.endOffset <= startOffset || item.startOffset >= endOffset) continue
      parts.push({
        itemIndex: itemIdx,
        charStart: Math.max(0, startOffset - item.startOffset),
        charEnd: Math.min(item.str.length, endOffset - item.startOffset),
      })
    }
    if (parts.length === 0) {
      from = normEnd
      continue
    }

    const firstItem = items[parts[0].itemIndex]
    // PDF 文本矩阵的 y 是基线位置（PDF 坐标，原点左下），跳转时再换算成 CSS 坐标
    const top = firstItem.transform[5]

    matches.push({
      pageNumber: page.pageNumber,
      matchIndex: matchIndex++,
      text: pageText.slice(startOffset, endOffset),
      startOffset,
      endOffset,
      top,
      parts,
    })

    from = normEnd
  }

  return { pageNumber: page.pageNumber, matches, pageText }
}

/**
 * 全文搜索：逐页检索，支持取消
 */
export async function searchDocument(
  doc: PdfjsDocument,
  keyword: string,
  caseSensitive = false,
  onProgress?: (pageNumber: number, totalPages: number) => void,
  shouldCancel?: () => boolean,
): Promise<SearchResult> {
  const result: SearchResult = {
    keyword,
    totalMatches: 0,
    totalPages: doc.numPages,
    pages: [],
  }

  if (!keyword.trim()) return result

  for (let i = 1; i <= doc.numPages; i++) {
    if (shouldCancel?.()) break

    const page = await doc.getPage(i)
    const pageResult = await searchPage(page, keyword, caseSensitive)

    if (pageResult.matches.length > 0) {
      result.pages.push(pageResult)
      result.totalMatches += pageResult.matches.length
    }

    onProgress?.(i, doc.numPages)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return result
}

/* ------------------------------------------------------------------ */
/*  Text Layer 内高亮（与文字像素级对齐，随缩放自动跟随）                 */
/* ------------------------------------------------------------------ */

const HIGHLIGHT_CLASS = 'search-highlight'
const ACTIVE_HIGHLIGHT_CLASS = 'search-highlight--active'

/**
 * 把单页的命中片段包裹成 <mark>，直接嵌在 PDF.js Text Layer 的 span 内。
 *
 * Text Layer 中每个非空文本项对应一个绝对定位、与画布文字精确对齐的 span；
 * 在 span 内部包裹 <mark>，高亮矩形即由浏览器按真实字形排版绘制，从根本上
 * 避免“估算字符宽度 + 手写坐标变换”带来的错位，任何缩放比下都与文字重合。
 *
 * 调用前 Text Layer 必须已渲染完成（buildTextLayer 的 promise 已 resolve），
 * 且容器内不能残留旧的高亮（应先调用 clearTextLayerHighlights）。
 *
 * @param partsByItem itemIndex -> 该 span 内需高亮的字符区间（按原文字符偏移）
 * @param activeMatch 当前激活的命中（用于区分颜色）
 */
export function applyTextLayerHighlights(
  container: HTMLDivElement,
  partsByItem: Map<number, Array<{ charStart: number; charEnd: number }>>,
  activeMatch?: SearchMatch | null,
): void {
  const activeItemSet = new Set<number>()
  if (activeMatch) {
    for (const part of activeMatch.parts) activeItemSet.add(part.itemIndex)
  }

  // Text Layer 只把非空文本项渲染成 span，且顺序与 textContent.items 一致；
  // <br> 与 endOfContent 均不是 span，因此 child 中的 span 序号即非空项序号。
  const spans = Array.from(container.children).filter(
    (el): el is HTMLSpanElement => el.tagName === 'SPAN',
  )
  const doc = container.ownerDocument

  for (const [itemIndex, rawRanges] of partsByItem) {
    const span = spans[itemIndex]
    if (!span) continue
    const original = span.textContent ?? ''
    if (!original) continue

    // 合并重叠/相邻区间（同一 span 可能被多个命中间隔命中）
    const ranges = rawRanges
      .map((r) => ({
        start: Math.max(0, Math.min(r.charStart, original.length)),
        end: Math.max(0, Math.min(r.charEnd, original.length)),
      }))
      .filter((r) => r.end > r.start)
      .sort((a, b) => a.start - b.start)
    if (ranges.length === 0) continue

    const merged: Array<{ start: number; end: number }> = []
    for (const r of ranges) {
      const last = merged[merged.length - 1]
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end)
      } else {
        merged.push({ ...r })
      }
    }

    const isActive = activeItemSet.has(itemIndex)
    span.textContent = ''

    let cursor = 0
    for (const r of merged) {
      if (r.start > cursor) {
        span.appendChild(doc.createTextNode(original.slice(cursor, r.start)))
      }
      const mark = doc.createElement('mark')
      mark.className = HIGHLIGHT_CLASS
      if (isActive) mark.classList.add(ACTIVE_HIGHLIGHT_CLASS)
      mark.textContent = original.slice(r.start, r.end)
      span.appendChild(mark)
      cursor = r.end
    }
    if (cursor < original.length) {
      span.appendChild(doc.createTextNode(original.slice(cursor)))
    }
  }
}

/** 清除 Text Layer 中的全部搜索高亮，恢复原始文字节点 */
export function clearTextLayerHighlights(container: HTMLDivElement): void {
  const marks = container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`)
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    // 合并被拆散的相邻文本节点，避免反复搜索后节点碎片化
    parent.normalize()
  })
}
