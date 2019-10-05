export const enum OperationTypes {
  // 使用字符串而不数字方便调试事件
  // using literal strings instead of numbers so that it's easier to inspect
  // debugger events
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear',
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate'
}
