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
    str?: string
    dir?: string
    transform?: number[]
    width?: number
    height?: number
    hasEOL?: boolean
    type?: string
  }>
  styles: Record<string, { fontFamily: string; ascent: number; descent: number; vertical: boolean }>
}

/** 带文本的 TextContent item（str 一定存在） */
export interface PdfjsTextItem {
  str: string
  dir: string
  transform: number[]
  width: number
  height: number
  hasEOL: boolean
}

/** PDF.js Annotation（简化） */
export interface PdfjsAnnotation {
  annotationType: number
  id: string
  rect: number[]
  url?: string
  dest?: string | unknown[]
}

/**
 * 匹配项在单个文本项中的片段信息
 * itemIndex 为该文本项在“有效文本项数组”中的下标（与 TextLayer 的 span 一一对应）；
 * charStart/charEnd 为片段在该文本项 str 内的字符下标。
 */
interface MatchFragment {
  itemIndex: number
  charStart: number
  charEnd: number
}

/** 单个搜索匹配结果 */
export interface SearchMatch {
  pageNumber: number
  matchIndex: number
  text: string
  /** 在页面“可见连续文本”中的起止偏移 */
  startOffset: number
  endOffset: number
  /** 命中所覆盖的每个文本项片段 */
  fragments: MatchFragment[]
  /**
   * 首片段所在文本项基线的 PDF 坐标 Y（scale=1，未翻转）。
   * 仅在页面尚未渲染、无法实测矩形时用于跳转定位的兜底估算。
   */
  fallbackTransformY: number
}

/** 归一化后参与页面文本拼接的文本项（与 TextLayer span 一一对应） */
export interface NormalizedTextItem {
  str: string
  dir: string
  transform: number[]
  width: number
  height: number
  hasEOL: boolean
  /** 该文本项在页面连续文本中的起始/结束偏移 */
  startOffset: number
  endOffset: number
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
        textDivs?: HTMLElement[]
      }): { promise: Promise<void> }
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
 *
 * 返回 textDivs：其中所有 str 已定义的文本项（含空串）按 textContent.items 原顺序排列，
 * 与 getPageTextWithOffsets() 返回的 items 一一对应，用于高亮定位。
 */
export async function buildTextLayer(
  page: PdfjsPage, container: HTMLDivElement, viewport: PdfjsViewport,
): Promise<HTMLSpanElement[]> {
  const pdfjs = getPdfjs()
  const textContent = await page.getTextContent()
  container.innerHTML = ''
  container.style.width = `${viewport.width}px`
  container.style.height = `${viewport.height}px`
  const textDivs: HTMLElement[] = []
  const task = pdfjs.renderTextLayer({
    textContent,
    container,
    viewport,
    textDivs,
    enhanceTextSelection: true,
  })
  await task.promise

  await task.promise

  // textDivs 与传入 textContent.items 中“str 已定义”的项严格同序（含空串项），
  // 纳入规则必须与 getPageTextWithOffsets() 完全一致，保证 span 与搜索文本项一一对应。
  const spans: HTMLSpanElement[] = []
  let divIdx = 0
  for (const item of textContent.items) {
    if (typeof item.str !== 'string' || !Array.isArray(item.transform)) {
      continue
    }
    const el = textDivs[divIdx++]
    if (el instanceof HTMLSpanElement) {
      spans.push(el)
    }
  }
  return spans
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

/**
 * 获取单页“读者所见”的连续文本，以及每个文本项在其中的偏移。
 *
 * PDF 常把一个视觉上连续的词拆成多个 text item，也常用多个 item 描述同一行。
 * 这里参照 PDF.js 官方阅读器 PDFFindController 的做法：
 *  - 直接拼接各文本项的 str（worker 的 TextChunker 已在合适位置补了空格）；
 *  - 行末（hasEOL，或几何上明显换行且存在间距）插入一个分隔空白；
 *  - 行尾连字符（如 exam-\nple）按读者阅读习惯合并成 example；
 *  - 每个文本项记录它在连续文本中的字符范围（分隔符不属于任何文本项）。
 *
 * 这样搜索按页面上看到的连续文字进行，跨文本项、跨行的词都能被检索到。
 */
export async function getPageTextWithOffsets(
  page: PdfjsPage,
): Promise<{ pageText: string; items: NormalizedTextItem[] }> {
  const textContent = await page.getTextContent()
  const rawItems = textContent.items.filter(
    (it): it is PdfjsTextItem =>
      typeof it.str === 'string' && Array.isArray(it.transform),
  )

  // 第一遍：先确定每个换行处是否需要做“去连字符合并”
  const joinHyphen = new Array<boolean>(rawItems.length).fill(false)
  for (let i = 0; i + 1 < rawItems.length; i++) {
    const item = rawItems[i]
    const next = rawItems[i + 1]
    joinHyphen[i] =
      isLineBreak(item, next) &&
      item.str.endsWith('-') &&
      /^[A-Za-z]/.test(next.str)
  }

  // 第二遍：拼接连续文本，同时记录每个文本项在其中的字符范围。
  // 保留 item.str 原文（高亮 Range 要在真实 span 文本上取字符），
  // 仅在连续文本中省略被合并的行尾 '-'，用 outStart/outEnd 描述范围。
  const chars: string[] = []
  const items: NormalizedTextItem[] = []
  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i]
    const str = item.str
    const dropHyphen = joinHyphen[i]
    const outStart = chars.length
    const emittedLen = dropHyphen ? str.length - 1 : str.length
    for (let c = 0; c < emittedLen; c++) chars.push(str[c])
    const outEnd = chars.length

    items.push({
      str,
      dir: item.dir || 'ltr',
      transform: item.transform,
      width: item.width || 0,
      height: item.height || 0,
      hasEOL: !!item.hasEOL,
      startOffset: outStart,
      endOffset: outEnd,
    })

    const next = rawItems[i + 1]
    // 换行处插入一个分隔空白；但“去连字符合并”时两端属于同一个词，不能插入空白
    if (next && isLineBreak(item, next) && !joinHyphen[i]) {
      chars.push(' ')
    }
  }

  return { pageText: chars.join(''), items }
}

/**
 * 判断两个相邻文本项之间在视觉上是否换行。
 * 优先信任 worker 给出的 hasEOL；缺失时按几何位置（纵向位移 / 水平回退）推断。
 */
function isLineBreak(
  cur: PdfjsTextItem,
  next: PdfjsTextItem,
): boolean {
  if (cur.hasEOL) return true

  const [, , , sy, x1, y1] = cur.transform
  const [, , , , x2, y2] = next.transform
  const fontSize = Math.max(Math.abs(sy), cur.height || 0, 1)
  const dy = y2 - y1
  const dx = x2 - (x1 + cur.width)

  // 纵向明显位移（约半个行高以上），或水平方向回退到行首附近
  if (Math.abs(dy) > fontSize * 0.5) return true
  if (dy <= -fontSize * 0.1 && dx < -cur.width * 0.5) return true
  return false
}

/**
 * 构造匹配用正则：
 *  - 转义正则元字符；
 *  - 查询中的连续空白（含换行）匹配页面上的任意空白，从而支持跨行短语；
 *  - 默认忽略大小写。
 */
function buildSearchRegex(keyword: string, caseSensitive: boolean): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = escaped.replace(/\s+/g, '\\s+')
  return new RegExp(pattern, caseSensitive ? 'g' : 'gi')
}

/**
 * 在单页中搜索关键词，返回所有匹配项。
 * 匹配基于“读者所见”的连续文本，命中片段映射回原始文本项，供高亮定位。
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

  const regex = buildSearchRegex(keyword, caseSensitive)

  let match: RegExpExecArray | null
  let matchIndex = 0
  while ((match = regex.exec(pageText)) !== null) {
    const startOffset = match.index
    const endOffset = startOffset + match[0].length
    if (endOffset <= startOffset) {
      regex.lastIndex++
      continue
    }

    // 命中必须至少覆盖一个文本项里的真实字符，且整体片段不能只落在行分隔空白上
    const fragments = buildMatchFragments(pageText, items, startOffset, endOffset)
    if (fragments.length > 0) {
      const firstItem = items[fragments[0].itemIndex]
      matches.push({
        pageNumber: page.pageNumber,
        matchIndex: matchIndex++,
        text: match[0],
        startOffset,
        endOffset,
        fragments,
        fallbackTransformY: firstItem.transform[5] ?? 0,
      })
    }

    if (match.index === regex.lastIndex) regex.lastIndex++
  }

  return { pageNumber: page.pageNumber, matches, pageText }
}

/**
 * 将一次命中 [startOffset, endOffset) 拆分到它所覆盖的各文本项上。
 * 命中跨越的分隔空白不属于任何片段；片段在每个文本项内是连续字符区间。
 *
 * charStart/charEnd 同时也是原始 item.str 中的字符下标：
 * 唯一的差异是去连字符时页面文本少了末尾的 '-'，而被命中的字符始终位于
 * 该 '-' 之前（紧邻下一行词首），因此区间索引在两种文本中一致，可直接用于 Range。
 */
function buildMatchFragments(
  pageText: string,
  items: NormalizedTextItem[],
  startOffset: number,
  endOffset: number,
): MatchFragment[] {
  void pageText
  const fragments: MatchFragment[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const overlapStart = Math.max(startOffset, item.startOffset)
    const overlapEnd = Math.min(endOffset, item.endOffset)
    if (overlapEnd <= overlapStart) continue
    fragments.push({
      itemIndex: i,
      charStart: overlapStart - item.startOffset,
      charEnd: overlapEnd - item.startOffset,
    })
  }
  return fragments
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

/**
 * 一次命中在页面上的测量结果：各文本行片段的矩形（相对高亮层容器坐标），
 * 以及整体包围盒。跳转定位时使用包围盒的顶部。
 */
export interface MatchRects {
  rects: DOMRect[]
  boundingTop: number
  boundingBottom: number
}

/**
 * 构建高亮层 — 直接在真实的 TextLayer <span> 上用 DOM Range 测量文字矩形。
 *
 * 矩形来自浏览器对 TextLayer 的实际布局结果（位置、字号、旋转、scaleX 拉伸都已包含），
 * 因此与读者在页面上看到的文字天然像素级对齐，不再依赖“等宽字”假设或手动坐标翻转。
 *
 * @param container    高亮层容器（与 TextLayer 重叠、同一页面坐标系）
 * @param matches      本页命中
 * @param textSpans    与搜索文本项一一对应的 TextLayer span（buildTextLayer 的返回值）
 * @param pageWidth    当前缩放下页面像素宽（用于设置高亮层尺寸）
 * @param pageHeight   当前缩放下页面像素高
 * @param currentMatchIndex 当前命中的页内 matchIndex
 * @returns 页内 matchIndex -> 测量矩形（仅包含成功测量的命中）
 */
export function buildHighlightLayer(
  container: HTMLDivElement,
  matches: SearchMatch[],
  textSpans: HTMLSpanElement[],
  pageWidth: number,
  pageHeight: number,
  currentMatchIndex?: number,
): Map<number, MatchRects> {
  container.innerHTML = ''
  container.style.position = 'absolute'
  container.style.top = '0'
  container.style.left = '0'
  container.style.width = `${pageWidth}px`
  container.style.height = `${pageHeight}px`
  container.style.pointerEvents = 'none'
  container.style.zIndex = '4'

  const containerRect = container.getBoundingClientRect()
  const measured = new Map<number, MatchRects>()

  for (const match of matches) {
    const isActive = match.matchIndex === currentMatchIndex
    const rects: DOMRect[] = []
    const group = document.createElement('div')
    group.className = 'search-highlight-group'
    if (isActive) group.classList.add('search-highlight-group--active')

    for (const fragment of match.fragments) {
      const span = textSpans[fragment.itemIndex]
      const textNode = span?.firstChild
      if (!span || !textNode || textNode.nodeType !== Node.TEXT_NODE ||
          fragment.charEnd <= fragment.charStart) {
        continue
      }

      // 每个文本项在 TextLayer 中是单行，Range 的 client rects 即该片段占据的行矩形
      const range = span.ownerDocument.createRange()
      try {
        range.setStart(textNode, fragment.charStart)
        range.setEnd(textNode, fragment.charEnd)
      } catch {
        continue
      }

      const clientRects = range.getClientRects()
      for (const rc of clientRects) {
        if (rc.width <= 0 || rc.height <= 0) continue
        const left = rc.left - containerRect.left
        const top = rc.top - containerRect.top
        const rect = new DOMRect(left, top, rc.width, rc.height)
        rects.push(rect)

        const highlight = document.createElement('div')
        highlight.className = 'search-highlight'
        highlight.style.left = `${left}px`
        highlight.style.top = `${top}px`
        highlight.style.width = `${rc.width}px`
        highlight.style.height = `${rc.height}px`
        group.appendChild(highlight)
      }
    }

    if (rects.length > 0) {
      container.appendChild(group)
      const top = Math.min(...rects.map((r) => r.top))
      const bottom = Math.max(...rects.map((r) => r.bottom))
      measured.set(match.matchIndex, { rects, boundingTop: top, boundingBottom: bottom })
    }
  }

  return measured
}

/**
 * 清除高亮层
 */
export function clearHighlightLayer(container: HTMLDivElement): void {
  container.innerHTML = ''
}
