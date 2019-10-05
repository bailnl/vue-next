import { isObject, toTypeString } from '@vue/shared'
import { mutableHandlers, readonlyHandlers } from './baseHandlers'

import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers
} from './collectionHandlers'

import { UnwrapNestedRefs } from './ref'
import { ReactiveEffect } from './effect'

// 用 WeakMap 来存储 {target -> key -> dep} 的连接。
// 从概念上讲，依赖关系用类来维护更容易，但是这样做可以减少内存上的开销。
// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
export type Dep = Set<ReactiveEffect>
export type KeyToDepMap = Map<string | symbol, Dep>
export const targetMap: WeakMap<any, KeyToDepMap> = new WeakMap()

// 使用 WeakMap 来缓存已经处理过转换过的数据
// WeakMaps that store {raw <-> observed} pairs.
const rawToReactive: WeakMap<any, any> = new WeakMap()
const reactiveToRaw: WeakMap<any, any> = new WeakMap()
const rawToReadonly: WeakMap<any, any> = new WeakMap()
const readonlyToRaw: WeakMap<any, any> = new WeakMap()

// 只读 和 不被响应化的值
// WeakSets for values that are marked readonly or non-reactive during
// observable creation.
const readonlyValues: WeakSet<any> = new WeakSet()
const nonReactiveValues: WeakSet<any> = new WeakSet()

// 声明集合的类型
const collectionTypes: Set<any> = new Set([Set, Map, WeakMap, WeakSet])
// 用于检测可以观察的值
const observableValueRE = /^\[object (?:Object|Array|Map|Set|WeakMap|WeakSet)\]$/

// 一个值能不能被观察，需要符合4个条件：
// 1. 不是vue实例 2.不是VNode实例 3. 是 Object|Array|Map|Set|WeakMap|WeakSet之一 4. 不是不用观察的值
const canObserve = (value: any): boolean => {
  return (
    !value._isVue &&
    !value._isVNode &&
    observableValueRE.test(toTypeString(value)) &&
    !nonReactiveValues.has(value)
  )
}

export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
export function reactive(target: object) {
  // 如果 target 是之前标记为 readonly的值就直接返回
  // if trying to observe a readonly proxy, return the readonly version.
  if (readonlyToRaw.has(target)) {
    return target
  }
  // 用户显式的标记为 readonly
  // target is explicitly marked as readonly by user
  if (readonlyValues.has(target)) {
    return readonly(target)
  }
  return createReactiveObject(
    target,
    rawToReactive,
    reactiveToRaw,
    mutableHandlers,
    mutableCollectionHandlers
  )
}

export function readonly<T extends object>(
  target: T
): Readonly<UnwrapNestedRefs<T>>
export function readonly(target: object) {
  // target 可能已经被观察且是可变的，拿到原始的值并返回只读的版本
  // value is a mutable observable, retrive its original and return
  // a readonly version.
  if (reactiveToRaw.has(target)) {
    target = reactiveToRaw.get(target)
  }
  return createReactiveObject(
    target,
    rawToReadonly,
    readonlyToRaw,
    readonlyHandlers,
    readonlyCollectionHandlers
  )
}

// 创建一个响应式的对象
function createReactiveObject(
  target: any,
  toProxy: WeakMap<any, any>,
  toRaw: WeakMap<any, any>,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>
) {
  // target 必须是一个对象
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target 是观察前的数据，但是之前观察过，直接从缓存中取
  // target already has corresponding Proxy
  let observed = toProxy.get(target)
  if (observed !== void 0) {
    return observed
  }

  // target 本身就是观察后的数据
  // target is already a Proxy
  if (toRaw.has(target)) {
    return target
  }
  // 只有 Object|Array|Map|Set|WeakMap|WeakSet 可以被观察
  // only a whitelist of value types can be observed.
  if (!canObserve(target)) {
    return target
  }

  // 根据类型选择， 集合类 还是 普通的 proxy 处理函数
  const handlers = collectionTypes.has(target.constructor)
    ? collectionHandlers
    : baseHandlers
  observed = new Proxy(target, handlers)
  // 缓存转换前后的数据
  toProxy.set(target, observed)
  toRaw.set(observed, target)
  // target 对应的依赖表声明
  if (!targetMap.has(target)) {
    targetMap.set(target, new Map())
  }
  // 返回观察后的数据
  return observed
}

// 判断是否响应式
export function isReactive(value: any): boolean {
  return reactiveToRaw.has(value) || readonlyToRaw.has(value)
}

// 判断是否是读
export function isReadonly(value: any): boolean {
  return readonlyToRaw.has(value)
}

// observed -> raw， 有可能本身就是
export function toRaw<T>(observed: T): T {
  return reactiveToRaw.get(observed) || readonlyToRaw.get(observed) || observed
}

// 标记为响应式只读的值
export function markReadonly<T>(value: T): T {
  readonlyValues.add(value)
  return value
}

// 标记为不需要响应式的值
export function markNonReactive<T>(value: T): T {
  nonReactiveValues.add(value)
  return value
}
