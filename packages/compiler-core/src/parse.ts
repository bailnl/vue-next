import {
  ErrorCodes,
  CompilerError,
  createCompilerError,
  defaultOnError
} from './errors'
import {
  assert,
  advancePositionWithMutation,
  advancePositionWithClone
} from './utils'
import {
  Namespace,
  Namespaces,
  AttributeNode,
  CommentNode,
  DirectiveNode,
  ElementNode,
  ElementTypes,
  ExpressionNode,
  NodeTypes,
  Position,
  RootNode,
  SourceLocation,
  TextNode,
  TemplateChildNode,
  InterpolationNode
} from './ast'

export interface ParserOptions {
  isVoidTag?: (tag: string) => boolean // e.g. img, br, hr
  getNamespace?: (tag: string, parent: ElementNode | undefined) => Namespace
  getTextMode?: (tag: string, ns: Namespace) => TextModes
  delimiters?: [string, string] // ['{{', '}}']
  ignoreSpaces?: boolean

  // Map to HTML entities. E.g., `{ "amp;": "&" }`
  // The full set is https://html.spec.whatwg.org/multipage/named-characters.html#named-character-references
  namedCharacterReferences?: { [name: string]: string | undefined }

  onError?: (error: CompilerError) => void
}

export const defaultParserOptions: Required<ParserOptions> = {
  delimiters: [`{{`, `}}`],
  ignoreSpaces: true,
  getNamespace: () => Namespaces.HTML,
  getTextMode: () => TextModes.DATA,
  isVoidTag: () => false,
  namedCharacterReferences: {
    'gt;': '>',
    'lt;': '<',
    'amp;': '&',
    'apos;': "'",
    'quot;': '"'
  },
  onError: defaultOnError
}

export const enum TextModes {
  //          | Elements | Entities | End sign              | Inside of
  DATA, //    | ✔       | ✔       | End tags of ancestors |
  RCDATA, //  | ✘       | ✔       | End tag of the parent | <textarea>
  RAWTEXT, // | ✘       | ✘       | End tag of the parent | <style>,<script>
  CDATA,
  ATTRIBUTE_VALUE
}

interface ParserContext {
  options: Required<ParserOptions>
  readonly originalSource: string
  source: string
  offset: number
  line: number
  column: number
  maxCRNameLength: number
}

export function parse(content: string, options: ParserOptions = {}): RootNode {
  const context = createParserContext(content, options)
  const start = getCursor(context)

  return {
    type: NodeTypes.ROOT,
    children: parseChildren(context, TextModes.DATA, []),
    imports: [],
    statements: [],
    hoists: [],
    codegenNode: undefined,
    loc: getSelection(context, start)
  }
}

function createParserContext(
  content: string,
  options: ParserOptions
): ParserContext {
  return {
    options: {
      ...defaultParserOptions,
      ...options
    },
    column: 1,
    line: 1,
    offset: 0,
    originalSource: content,
    source: content,
    maxCRNameLength: Object.keys(
      options.namedCharacterReferences ||
        defaultParserOptions.namedCharacterReferences
    ).reduce((max, name) => Math.max(max, name.length), 0)
  }
}

function parseChildren(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  const parent = last(ancestors)
  const ns = parent ? parent.ns : Namespaces.HTML
  const nodes: TemplateChildNode[] = []

  while (!isEnd(context, mode, ancestors)) {
    __DEV__ && assert(context.source.length > 0)
    const s = context.source
    let node: TemplateChildNode | TemplateChildNode[] | undefined = undefined

    // 插值表达式
    if (startsWith(s, context.options.delimiters[0])) {
      // '{{'
      node = parseInterpolation(context, mode)
    } else if (mode === TextModes.DATA && s[0] === '<') {
      // https://html.spec.whatwg.org/multipage/parsing.html#tag-open-state
      if (s.length === 1) {
        emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 1)
      } else if (s[1] === '!') {
        // https://html.spec.whatwg.org/multipage/parsing.html#markup-declaration-open-state
        if (startsWith(s, '<!--')) {
          // 注释
          node = parseComment(context)
        } else if (startsWith(s, '<!DOCTYPE')) {
          // 文档声明
          // Ignore DOCTYPE by a limitation.
          node = parseBogusComment(context)
        } else if (startsWith(s, '<![CDATA[')) {
          // CDATA 数据， 作用请查看 https://stackoverflow.com/questions/2784183/what-does-cdata-in-xml-mean
          if (ns !== Namespaces.HTML) {
            node = parseCDATA(context, ancestors)
          } else {
            emitError(context, ErrorCodes.CDATA_IN_HTML_CONTENT)
            node = parseBogusComment(context)
          }
        } else {
          // 到了此处，说明就一个不合规范的注释类代码比如 <!fuck>
          emitError(context, ErrorCodes.INCORRECTLY_OPENED_COMMENT)
          node = parseBogusComment(context)
        }
      } else if (s[1] === '/') {
        // </ 表示结束标签
        // https://html.spec.whatwg.org/multipage/parsing.html#end-tag-open-state
        if (s.length === 2) {
          // 但是不能只剩2个字符， </ 酱紫就是不规范的
          emitError(context, ErrorCodes.EOF_BEFORE_TAG_NAME, 2)
        } else if (s[2] === '>') {
          // </> 也不行， 缺少 tag name, 我表示很绝望， 并没有 react 里面的 <></> 语法
          emitError(context, ErrorCodes.MISSING_END_TAG_NAME, 2)
          advanceBy(context, 3)
          continue
        } else if (/[a-z]/i.test(s[2])) {
          // TODO: </a 开头不合法吗？？？, 还标记为 Vue 特定parse错误!!!
          emitError(context, ErrorCodes.X_INVALID_END_TAG)
          parseTag(context, TagType.End, parent)
          continue
        } else {
          // 要显示 < 请使用 &lt 替代
          emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 2)
          node = parseBogusComment(context)
        }
      } else if (/[a-z]/i.test(s[1])) {
        node = parseElement(context, ancestors)
      } else if (s[1] === '?') {
        // <? 这种也不合法，又不是写 php(世界上最好的语言)
        emitError(
          context,
          ErrorCodes.UNEXPECTED_QUESTION_MARK_INSTEAD_OF_TAG_NAME,
          1
        )
        node = parseBogusComment(context)
      } else {
        emitError(context, ErrorCodes.INVALID_FIRST_CHARACTER_OF_TAG_NAME, 1)
      }
    }

    // 如果不是 插值表达式 or 节点， 那就是文本
    if (!node) {
      node = parseText(context, mode)
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        pushNode(context, nodes, node[i])
      }
    } else {
      pushNode(context, nodes, node)
    }
  }

  return nodes
}

function pushNode(
  context: ParserContext,
  nodes: TemplateChildNode[],
  node: TemplateChildNode
): void {
  // 生产环境忽略注释
  // ignore comments in production
  /* istanbul ignore next */
  if (!__DEV__ && node.type === NodeTypes.COMMENT) {
    return
  }

  // 允许配置忽略空白字符
  if (
    context.options.ignoreSpaces &&
    node.type === NodeTypes.TEXT &&
    node.isEmpty
  ) {
    return
  }

  // 如果当前节点和上一个节点都文本节点并且是连续的，就合并
  // 比如  a < b 这种情况
  // 否则就放入 nodes 里面
  // Merge if both this and the previous node are text and those are consecutive.
  // This happens on "a < b" or something like.
  const prev = last(nodes)
  if (
    prev &&
    prev.type === NodeTypes.TEXT &&
    node.type === NodeTypes.TEXT &&
    prev.loc.end.offset === node.loc.start.offset
  ) {
    prev.content += node.content
    prev.isEmpty = prev.content.trim().length === 0
    prev.loc.end = node.loc.end
    prev.loc.source += node.loc.source
  } else {
    nodes.push(node)
  }
}

function parseCDATA(
  context: ParserContext,
  ancestors: ElementNode[]
): TemplateChildNode[] {
  __DEV__ &&
    assert(last(ancestors) == null || last(ancestors)!.ns !== Namespaces.HTML)
  __DEV__ && assert(startsWith(context.source, '<![CDATA['))

  advanceBy(context, 9)
  const nodes = parseChildren(context, TextModes.CDATA, ancestors)
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_CDATA)
  } else {
    __DEV__ && assert(startsWith(context.source, ']]>'))
    advanceBy(context, 3)
  }

  return nodes
}

function parseComment(context: ParserContext): CommentNode {
  __DEV__ && assert(startsWith(context.source, '<!--'))

  const start = getCursor(context)
  let content: string

  // Regular comment.
  const match = /--(\!)?>/.exec(context.source)
  if (!match) {
    content = context.source.slice(4)
    advanceBy(context, context.source.length)
    emitError(context, ErrorCodes.EOF_IN_COMMENT)
  } else {
    if (match.index <= 3) {
      emitError(context, ErrorCodes.ABRUPT_CLOSING_OF_EMPTY_COMMENT)
    }
    if (match[1]) {
      emitError(context, ErrorCodes.INCORRECTLY_CLOSED_COMMENT)
    }
    content = context.source.slice(4, match.index)

    // Advancing with reporting nested comments.
    const s = context.source.slice(0, match.index)
    let prevIndex = 1,
      nestedIndex = 0
    while ((nestedIndex = s.indexOf('<!--', prevIndex)) !== -1) {
      advanceBy(context, nestedIndex - prevIndex + 1)
      if (nestedIndex + 4 < s.length) {
        emitError(context, ErrorCodes.NESTED_COMMENT)
      }
      prevIndex = nestedIndex + 1
    }
    advanceBy(context, match.index + match[0].length - prevIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseBogusComment(context: ParserContext): CommentNode | undefined {
  __DEV__ && assert(/^<(?:[\!\?]|\/[^a-z>])/i.test(context.source))

  const start = getCursor(context)
  const contentStart = context.source[1] === '?' ? 1 : 2
  let content: string

  const closeIndex = context.source.indexOf('>')
  if (closeIndex === -1) {
    content = context.source.slice(contentStart)
    advanceBy(context, context.source.length)
  } else {
    content = context.source.slice(contentStart, closeIndex)
    advanceBy(context, closeIndex + 1)
  }

  return {
    type: NodeTypes.COMMENT,
    content,
    loc: getSelection(context, start)
  }
}

function parseElement(
  context: ParserContext,
  ancestors: ElementNode[]
): ElementNode | undefined {
  __DEV__ && assert(/^<[a-z]/i.test(context.source))

  // Start tag.
  const parent = last(ancestors)
  const element = parseTag(context, TagType.Start, parent)

  if (element.isSelfClosing || context.options.isVoidTag(element.tag)) {
    return element
  }

  // Children.
  ancestors.push(element)
  const mode = (context.options.getTextMode(
    element.tag,
    element.ns
  ) as unknown) as TextModes
  const children = parseChildren(context, mode, ancestors)
  ancestors.pop()

  element.children = children

  // End tag.
  if (startsWithEndTagOpen(context.source, element.tag)) {
    parseTag(context, TagType.End, parent)
  } else {
    emitError(context, ErrorCodes.X_MISSING_END_TAG)
    if (context.source.length === 0 && element.tag.toLowerCase() === 'script') {
      const first = children[0]
      if (first && startsWith(first.loc.source, '<!--')) {
        emitError(context, ErrorCodes.EOF_IN_SCRIPT_HTML_COMMENT_LIKE_TEXT)
      }
    }
  }

  element.loc = getSelection(context, element.loc.start)
  return element
}

const enum TagType {
  Start,
  End
}

// 解析标签， 开始 或者 结束
/**
 * Parse a tag (E.g. `<div id=a>`) with that type (start tag or end tag).
 */
function parseTag(
  context: ParserContext,
  type: TagType,
  parent: ElementNode | undefined
): ElementNode {
  __DEV__ && assert(/^<\/?[a-z]/i.test(context.source))
  __DEV__ &&
    assert(
      type === (startsWith(context.source, '</') ? TagType.End : TagType.Start)
    )

  // Tag open.
  const start = getCursor(context)
  const match = /^<\/?([a-z][^\t\r\n\f />]*)/i.exec(context.source)!
  const tag = match[1]
  const props = []
  const ns = context.options.getNamespace(tag, parent)

  // 确定 tag 的类型
  let tagType = ElementTypes.ELEMENT
  if (tag === 'slot') tagType = ElementTypes.SLOT
  else if (tag === 'template') tagType = ElementTypes.TEMPLATE
  else if (/[A-Z-]/.test(tag)) tagType = ElementTypes.COMPONENT

  // 步进
  advanceBy(context, match[0].length)
  advanceSpaces(context)

  // 开始解析属性
  // Attributes.
  const attributeNames = new Set<string>()
  while (
    context.source.length > 0 &&
    !startsWith(context.source, '>') &&
    !startsWith(context.source, '/>')
  ) {
    // 标签意外结束 source 可能是 / href=""> 不应该出现的 /
    // 如果是结束的 / 就进不来 while 了。  所以有 / 一定是错了。
    if (startsWith(context.source, '/')) {
      emitError(context, ErrorCodes.UNEXPECTED_SOLIDUS_IN_TAG)
      advanceBy(context, 1)
      advanceSpaces(context)
      continue
    }
    // 如果type 为标签结束就不应该有属性 例如  </p a="">
    if (type === TagType.End) {
      emitError(context, ErrorCodes.END_TAG_WITH_ATTRIBUTES)
    }

    // 解析单个属性
    const attr = parseAttribute(context, attributeNames)
    // 标签开始就存起来
    if (type === TagType.Start) {
      props.push(attr)
    }

    // 属性之间需要空白符
    if (/^[^\t\r\n\f />]/.test(context.source)) {
      emitError(context, ErrorCodes.MISSING_WHITESPACE_BETWEEN_ATTRIBUTES)
    }
    // 步进空白符
    advanceSpaces(context)
  }

  // Tag close.
  let isSelfClosing = false
  // 有开始没有结束
  if (context.source.length === 0) {
    emitError(context, ErrorCodes.EOF_IN_TAG)
  } else {
    // 自闭合
    isSelfClosing = startsWith(context.source, '/>')
    if (type === TagType.End && isSelfClosing) {
      emitError(context, ErrorCodes.END_TAG_WITH_TRAILING_SOLIDUS)
    }
    // 根据是否自闭包来步进
    advanceBy(context, isSelfClosing ? 2 : 1)
  }

  return {
    type: NodeTypes.ELEMENT,
    ns,
    tag,
    tagType,
    props,
    isSelfClosing,
    children: [],
    loc: getSelection(context, start),
    codegenNode: undefined // to be created during transform phase
  }
}

// 解析单个属性 可能是指令 也可能是原生的 attr
function parseAttribute(
  context: ParserContext,
  nameSet: Set<string>
): AttributeNode | DirectiveNode {
  __DEV__ && assert(/^[^\t\r\n\f />]/.test(context.source))

  // Name.
  const start = getCursor(context)
  const match = /^[^\t\r\n\f />][^\t\r\n\f />=]*/.exec(context.source)!
  const name = match[0]

  // 属性重复
  if (nameSet.has(name)) {
    emitError(context, ErrorCodes.DUPLICATE_ATTRIBUTE)
  }
  // 添加属性名字表中
  nameSet.add(name)

  // 缺少属性名 比如 <a ="1">
  if (name[0] === '=') {
    emitError(context, ErrorCodes.UNEXPECTED_EQUALS_SIGN_BEFORE_ATTRIBUTE_NAME)
  }
  // <a href'="1"> 像属性名包含 "'< 都是异常情况
  {
    const pattern = /["'<]/g
    let m: RegExpExecArray | null
    while ((m = pattern.exec(name)) !== null) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_ATTRIBUTE_NAME,
        m.index
      )
    }
  }

  // 处理完异常情况后就可以步进了。
  advanceBy(context, name.length)

  // Value
  let value:
    | {
        content: string
        isQuoted: boolean
        loc: SourceLocation
      }
    | undefined = undefined

  if (/^[\t\r\n\f ]*=/.test(context.source)) {
    advanceSpaces(context)
    advanceBy(context, 1)
    advanceSpaces(context)
    value = parseAttributeValue(context)
    if (!value) {
      emitError(context, ErrorCodes.MISSING_ATTRIBUTE_VALUE)
    }
  }
  const loc = getSelection(context, start)

  // 如果是vue prop开头的属性名就是指令
  // v-if v-bind:prop v-on:click @click :[key] 等等
  if (/^(v-|:|@|#)/.test(name)) {
    const match = /(?:^v-([a-z0-9-]+))?(?:(?::|^@|^#)([^\.]+))?(.+)?$/i.exec(
      name
    )!

    let arg: ExpressionNode | undefined

    if (match[2]) {
      // 例如 name 是 v-bind:testProp.sync，match[2] 就是 prop
      // shift() 之后的结果就是 v-bind:  然后取长度就是开始的偏移位置
      // 所以 loc 的就是 testProp 相关的信息
      const startOffset = name.split(match[2], 2)!.shift()!.length
      const loc = getSelection(
        context,
        getNewPosition(context, start, startOffset),
        getNewPosition(context, start, startOffset + match[2].length)
      )
      let content = match[2]
      // 默认标记为静态
      let isStatic = true

      //  动态属性名的情况 <div v-bind:[key]="value"></div>
      // 查看相关的RFC https://github.com/vuejs/rfcs/blob/master/active-rfcs/0003-dynamic-directive-arguments.md
      if (content.startsWith('[')) {
        // 标记为非静态
        isStatic = false

        // 只有开始没有结束
        if (!content.endsWith(']')) {
          emitError(
            context,
            ErrorCodes.X_MISSING_DYNAMIC_DIRECTIVE_ARGUMENT_END
          )
        }

        // content 是 [key] 取到 key
        content = content.substr(1, content.length - 2)
      }

      arg = {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content,
        isStatic,
        loc
      }
    }

    if (value && value.isQuoted) {
      const valueLoc = value.loc
      valueLoc.start.offset++
      valueLoc.start.column++
      valueLoc.end = advancePositionWithClone(valueLoc.start, value.content)
      valueLoc.source = valueLoc.source.slice(1, -1)
    }

    return {
      type: NodeTypes.DIRECTIVE,
      name:
        match[1] ||
        (startsWith(name, ':')
          ? 'bind'
          : startsWith(name, '@')
            ? 'on'
            : 'slot'),
      exp: value && {
        type: NodeTypes.SIMPLE_EXPRESSION,
        content: value.content,
        isStatic: false,
        loc: value.loc
      },
      arg,
      modifiers: match[3] ? match[3].substr(1).split('.') : [],
      loc
    }
  }

  return {
    type: NodeTypes.ATTRIBUTE,
    name,
    value: value && {
      type: NodeTypes.TEXT,
      content: value.content,
      isEmpty: value.content.trim().length === 0,
      loc: value.loc
    },
    loc
  }
}

function parseAttributeValue(
  context: ParserContext
):
  | {
      content: string
      isQuoted: boolean
      loc: SourceLocation
    }
  | undefined {
  const start = getCursor(context)
  let content: string

  const quote = context.source[0]
  const isQuoted = quote === `"` || quote === `'`
  if (isQuoted) {
    // Quoted value.
    advanceBy(context, 1)

    const endIndex = context.source.indexOf(quote)
    if (endIndex === -1) {
      content = parseTextData(
        context,
        context.source.length,
        TextModes.ATTRIBUTE_VALUE
      )
    } else {
      content = parseTextData(context, endIndex, TextModes.ATTRIBUTE_VALUE)
      advanceBy(context, 1)
    }
  } else {
    // Unquoted
    const match = /^[^\t\r\n\f >]+/.exec(context.source)
    if (!match) {
      return undefined
    }
    let unexpectedChars = /["'<=`]/g
    let m: RegExpExecArray | null
    while ((m = unexpectedChars.exec(match[0])) !== null) {
      emitError(
        context,
        ErrorCodes.UNEXPECTED_CHARACTER_IN_UNQUOTED_ATTRIBUTE_VALUE,
        m.index
      )
    }
    content = parseTextData(context, match[0].length, TextModes.ATTRIBUTE_VALUE)
  }

  return { content, isQuoted, loc: getSelection(context, start) }
}

function parseInterpolation(
  context: ParserContext,
  mode: TextModes
): InterpolationNode | undefined {
  const [open, close] = context.options.delimiters
  __DEV__ && assert(startsWith(context.source, open))

  const closeIndex = context.source.indexOf(close, open.length)
  if (closeIndex === -1) {
    emitError(context, ErrorCodes.X_MISSING_INTERPOLATION_END)
    return undefined
  }

  const start = getCursor(context)
  advanceBy(context, open.length)
  const innerStart = getCursor(context)
  const innerEnd = getCursor(context)
  const rawContentLength = closeIndex - open.length
  const rawContent = context.source.slice(0, rawContentLength)
  const preTrimContent = parseTextData(context, rawContentLength, mode)
  const content = preTrimContent.trim()
  const startOffset = preTrimContent.indexOf(content)
  if (startOffset > 0) {
    advancePositionWithMutation(innerStart, rawContent, startOffset)
  }
  const endOffset =
    rawContentLength - (preTrimContent.length - content.length - startOffset)
  advancePositionWithMutation(innerEnd, rawContent, endOffset)
  advanceBy(context, close.length)

  return {
    type: NodeTypes.INTERPOLATION,
    content: {
      type: NodeTypes.SIMPLE_EXPRESSION,
      isStatic: false,
      content,
      loc: getSelection(context, innerStart, innerEnd)
    },
    loc: getSelection(context, start)
  }
}

function parseText(context: ParserContext, mode: TextModes): TextNode {
  __DEV__ && assert(context.source.length > 0)

  // 找到应该结束的位置，以下4个条件，哪个更接近就是结束的位置
  // 1. <   2. delimiters.open(默认{{)   3. CDATA模式时 ]]>  4.代码结束
  // 比如 context 是 abc{{ msg }}<span>123</span>
  // 结束的位置应该是 abc，而不是 abc{{ msg }}， 因为 {{ 比 < 更接近。
  const [open] = context.options.delimiters
  const endIndex = Math.min(
    ...[
      context.source.indexOf('<', 1),
      context.source.indexOf(open, 1),
      mode === TextModes.CDATA ? context.source.indexOf(']]>') : -1,
      context.source.length
    ].filter(n => n !== -1)
  )
  __DEV__ && assert(endIndex > 0)

  // 获取未截取前的位置
  const start = getCursor(context)
  const content = parseTextData(context, endIndex, mode)

  // 标记类型，内容及位置信息
  return {
    type: NodeTypes.TEXT,
    content,
    loc: getSelection(context, start),
    isEmpty: !content.trim()
  }
}

// 从当前位置获取给定长度的文本数据，转换文本数据中的HTML实体
/**
 * Get text data with a given length from the current location.
 * This translates HTML entities in the text data.
 */
function parseTextData(
  context: ParserContext,
  length: number,
  mode: TextModes
): string {
  if (mode === TextModes.RAWTEXT || mode === TextModes.CDATA) {
    const text = context.source.slice(0, length)
    advanceBy(context, length)
    return text
  }

  // DATA or RCDATA. Entity decoding required.
  const end = context.offset + length
  let text: string = ''

  while (context.offset < end) {
    const head = /&(?:#x?)?/i.exec(context.source)
    if (!head || context.offset + head.index >= end) {
      const remaining = end - context.offset
      text += context.source.slice(0, remaining)
      advanceBy(context, remaining)
      break
    }

    // Advance to the "&".
    text += context.source.slice(0, head.index)
    advanceBy(context, head.index)

    if (head[0] === '&') {
      // Named character reference.
      let name = '',
        value: string | undefined = undefined
      // 符合 &[0-9a-z] 开头的模式。比如 &lt;
      if (/[0-9a-z]/i.test(context.source[1])) {
        // web端的实体符号映射表在 packages/compiler-dom/src/namedChars.json
        // maxCRNameLength 就是映射表中实体符号编码（也就是key）最长的那个。
        // 不能从头开始找，因为没有办法确认 &lt 还是 &lt; ，后者明显多了一个字符;
        // 所以得从最长的开始找，找到就退出。
        // 比如用 source是  &lt;666
        // 那么遍历映射表到key长度为3的时候，就取到了 lt;(也就是变量name)，去表里面找是否符合的数据
        // 如果从头开始匹配，就匹配成了 lt 了。 那; 怎么办。
        for (
          let length = context.maxCRNameLength;
          !value && length > 0;
          --length
        ) {
          // 例如把 &lt; => 变成 lt;
          name = context.source.substr(1, length)
          // 从映射表里找出来对应的符号出来
          value = context.options.namedCharacterReferences[name]
        }
        if (value) {
          // 是否存在分号，是&lt; 还是 &lt
          const semi = name.endsWith(';')
          // 此条件进入属性值
          // 比如 &lt=
          if (
            mode === TextModes.ATTRIBUTE_VALUE &&
            !semi &&
            /[=a-z0-9]/i.test(context.source[1 + name.length] || '')
          ) {
            text += '&'
            text += name
            advanceBy(context, 1 + name.length)
          } else {
            text += value
            advanceBy(context, 1 + name.length)
            if (!semi) {
              emitError(
                context,
                ErrorCodes.MISSING_SEMICOLON_AFTER_CHARACTER_REFERENCE
              )
            }
          }
        } else {
          // 没有在实体映射表中找到
          emitError(context, ErrorCodes.UNKNOWN_NAMED_CHARACTER_REFERENCE)
          text += '&'
          text += name
          advanceBy(context, 1 + name.length)
        }
      } else {
        // 可能是 &= 之类的，不符号 &[0-9a-z] 就直接步进
        text += '&'
        advanceBy(context, 1)
      }
    } else {
      // 比如符号 ẚ => &#x1E9A;  ¢ => &#162;
      // 数字型字符， 比如后者
      // Numeric character reference.
      const hex = head[0] === '&#x'
      const pattern = hex ? /^&#x([0-9a-f]+);?/i : /^&#([0-9]+);?/
      const body = pattern.exec(context.source)
      // 如果没有匹配到就报错！仅 &#x 或者 &#
      if (!body) {
        text += head[0]
        emitError(
          context,
          ErrorCodes.ABSENCE_OF_DIGITS_IN_NUMERIC_CHARACTER_REFERENCE
        )
        advanceBy(context, head[0].length)
      } else {
        // https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
        let cp = Number.parseInt(body[1], hex ? 16 : 10)
        // 空
        if (cp === 0) {
          emitError(context, ErrorCodes.NULL_CHARACTER_REFERENCE)
          cp = 0xfffd
        } else if (cp > 0x10ffff) {
          // 超出范围
          emitError(
            context,
            ErrorCodes.CHARACTER_REFERENCE_OUTSIDE_UNICODE_RANGE
          )
          cp = 0xfffd
        } else if (cp >= 0xd800 && cp <= 0xdfff) {
          // 这个范围不能用，不成对。
          // Illegal numeric character reference: non-pair surrogate.
          emitError(context, ErrorCodes.SURROGATE_CHARACTER_REFERENCE)
          cp = 0xfffd
        } else if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) {
          // 不是字符， 那是啥？
          // Illegal numeric character reference: non character.
          emitError(context, ErrorCodes.NONCHARACTER_CHARACTER_REFERENCE)
        } else if (
          (cp >= 0x01 && cp <= 0x08) ||
          cp === 0x0b ||
          (cp >= 0x0d && cp <= 0x1f) ||
          (cp >= 0x7f && cp <= 0x9f)
        ) {
          // 控制字符
          // Illegal numeric character reference: control character.
          emitError(context, ErrorCodes.CONTROL_CHARACTER_REFERENCE)
          cp = CCR_REPLACEMENTS[cp] || cp
        }
        // 愉快的通过，转成字符
        // ẚ => &#x1E9A;  cp 就是  parseInt('1E9A', 16) 最后得到 ẚ
        text += String.fromCodePoint(cp)
        advanceBy(context, body[0].length)
        if (!body![0].endsWith(';')) {
          emitError(
            context,
            ErrorCodes.MISSING_SEMICOLON_AFTER_CHARACTER_REFERENCE
          )
        }
      }
    }
  }

  // 最终把各种编码符号转出来
  return text
}

function getCursor(context: ParserContext): Position {
  const { column, line, offset } = context
  return { column, line, offset }
}

function getSelection(
  context: ParserContext,
  start: Position,
  end?: Position
): SourceLocation {
  end = end || getCursor(context)
  return {
    start,
    end,
    source: context.originalSource.slice(start.offset, end.offset)
  }
}

function last<T>(xs: T[]): T | undefined {
  return xs[xs.length - 1]
}

function startsWith(source: string, searchString: string): boolean {
  return source.startsWith(searchString)
}

function advanceBy(context: ParserContext, numberOfCharacters: number): void {
  const { source } = context
  __DEV__ && assert(numberOfCharacters <= source.length)
  advancePositionWithMutation(context, source, numberOfCharacters)
  context.source = source.slice(numberOfCharacters)
}

function advanceSpaces(context: ParserContext): void {
  const match = /^[\t\r\n\f ]+/.exec(context.source)
  if (match) {
    advanceBy(context, match[0].length)
  }
}

function getNewPosition(
  context: ParserContext,
  start: Position,
  numberOfCharacters: number
): Position {
  return advancePositionWithClone(
    start,
    context.originalSource.slice(start.offset, numberOfCharacters),
    numberOfCharacters
  )
}

function emitError(
  context: ParserContext,
  code: ErrorCodes,
  offset?: number
): void {
  const loc = getCursor(context)
  if (offset) {
    loc.offset += offset
    loc.column += offset
  }
  context.options.onError(
    createCompilerError(code, {
      start: loc,
      end: loc,
      source: ''
    })
  )
}

function isEnd(
  context: ParserContext,
  mode: TextModes,
  ancestors: ElementNode[]
): boolean {
  const s = context.source

  switch (mode) {
    case TextModes.DATA:
      if (startsWith(s, '</')) {
        //TODO: probably bad performance
        for (let i = ancestors.length - 1; i >= 0; --i) {
          if (startsWithEndTagOpen(s, ancestors[i].tag)) {
            return true
          }
        }
      }
      break

    case TextModes.RCDATA:
    case TextModes.RAWTEXT: {
      const parent = last(ancestors)
      if (parent && startsWithEndTagOpen(s, parent.tag)) {
        return true
      }
      break
    }

    case TextModes.CDATA:
      if (startsWith(s, ']]>')) {
        return true
      }
      break
  }

  return !s
}

function startsWithEndTagOpen(source: string, tag: string): boolean {
  return (
    startsWith(source, '</') &&
    source.substr(2, tag.length).toLowerCase() === tag.toLowerCase() &&
    /[\t\n\f />]/.test(source[2 + tag.length] || '>')
  )
}

// https://html.spec.whatwg.org/multipage/parsing.html#numeric-character-reference-end-state
const CCR_REPLACEMENTS: { [key: number]: number | undefined } = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178
}
