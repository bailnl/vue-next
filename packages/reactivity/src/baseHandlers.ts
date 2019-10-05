import { reactive, readonly, toRaw } from './reactive'
import { OperationTypes } from './operations'
import { track, trigger } from './effect'
import { LOCKED } from './lock'
import { isObject, hasOwn } from '@vue/shared'
import { isRef } from './ref'

// 找到所有内置的 Symbol
const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(value => typeof value === 'symbol')
)

// 创建 getter, 通过 isReadonly 来决定 mutable 或者 readonly
function createGetter(isReadonly: boolean) {
  return function get(target: any, key: string | symbol, receiver: any) {
    const res = Reflect.get(target, key, receiver)
    // 如果 key 为 symbol 直接返回
    if (typeof key === 'symbol' && builtInSymbols.has(key)) {
      return res
    }
    // 如果 ref 类型，就取 value， 自动 unwrap
    if (isRef(res)) {
      return res.value
    }
    // 当取值时，追踪其变化
    track(target, OperationTypes.GET, key)
    return isObject(res)
      ? isReadonly
        ? // need to lazy access readonly and reactive here to avoid
          // circular dependency
          readonly(res)
        : reactive(res)
      : res
  }
}

// 设置属性的 handler
function set(
  target: any,
  key: string | symbol,
  value: any,
  receiver: any
): boolean {
  value = toRaw(value)
  const hadKey = hasOwn(target, key)
  const oldValue = target[key]
  if (isRef(oldValue) && !isRef(value)) {
    oldValue.value = value
    return true
  }
  const result = Reflect.set(target, key, value, receiver)
  // 如果 target 是原型链上的某个对象，不触发
  // 可以查阅，proxy set handler 参数 receiver
  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy/handler/set#Parameters
  // don't trigger if target is something up in the prototype chain of original
  if (target === toRaw(receiver)) {
    // 根据hadKey 来判断是 添加还是设置操作， 开发模式添加多的信息
    /* istanbul ignore else */
    if (__DEV__) {
      const extraInfo = { oldValue, newValue: value }
      if (!hadKey) {
        trigger(target, OperationTypes.ADD, key, extraInfo)
      } else if (value !== oldValue) {
        trigger(target, OperationTypes.SET, key, extraInfo)
      }
    } else {
      if (!hadKey) {
        trigger(target, OperationTypes.ADD, key)
      } else if (value !== oldValue) {
        trigger(target, OperationTypes.SET, key)
      }
    }
  }
  return result
}

// 删除属性的 handler
function deleteProperty(target: any, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = target[key]
  const result = Reflect.deleteProperty(target, key)
  if (hadKey) {
    // 开发模式添加多的信息
    /* istanbul ignore else */
    if (__DEV__) {
      trigger(target, OperationTypes.DELETE, key, { oldValue })
    } else {
      trigger(target, OperationTypes.DELETE, key)
    }
  }
  return result
}

// has handler 当使用类似 prop in target 时会触发
function has(target: any, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  track(target, OperationTypes.HAS, key)
  return result
}

// ownKeys handler 当使用类似 Object.keys(target) 迭代器时会触发
function ownKeys(target: any): (string | number | symbol)[] {
  track(target, OperationTypes.ITERATE)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<any> = {
  get: createGetter(false),
  set,
  deleteProperty,
  has,
  ownKeys
}

// readonly 的 proxy handlers， 和 mutableHandlers 不一样的地方在于当 LOCKED 为 true 会锁住操作并报warning
export const readonlyHandlers: ProxyHandler<any> = {
  get: createGetter(true),

  set(target: any, key: string | symbol, value: any, receiver: any): boolean {
    // 可以通过unlock来控制 LOCKED flag 来解锁 readonly 的操作
    if (LOCKED) {
      if (__DEV__) {
        console.warn(
          `Set operation on key "${key as any}" failed: target is readonly.`,
          target
        )
      }
      return true
    } else {
      return set(target, key, value, receiver)
    }
  },

  deleteProperty(target: any, key: string | symbol): boolean {
    // 可以通过unlock来控制 LOCKED flag 来解锁 readonly 的操作
    if (LOCKED) {
      if (__DEV__) {
        console.warn(
          `Delete operation on key "${key as any}" failed: target is readonly.`,
          target
        )
      }
      return true
    } else {
      return deleteProperty(target, key)
    }
  },

  has,
  ownKeys
}
