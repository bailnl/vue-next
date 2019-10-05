import { track, trigger } from './effect'
import { OperationTypes } from './operations'
import { isObject } from '@vue/shared'
import { reactive } from './reactive'

// 定义 Ref 接口, 包含 _isRef 用于表示是否为 ref, value 用于承载真实的值 例如，ref(0)，value 就是 0
export interface Ref<T> {
  _isRef: true
  value: UnwrapNestedRefs<T>
}

export type UnwrapNestedRefs<T> = T extends Ref<any> ? T : UnwrapRef<T>

// 转换方法，如果是对象就直接转成响应式的值， 否则直接使用
// 有可能是 ref({ a: 1}) 这么使用
const convert = (val: any): any => (isObject(val) ? reactive(val) : val)

export function ref<T>(raw: T): Ref<T> {
  raw = convert(raw)

  // 生成一个包装后的值
  const v = {
    _isRef: true,
    get value() {
      // 追踪 getter 操作，用于收集依赖等
      track(v, OperationTypes.GET, '')
      return raw
    },
    set value(newVal) {
      // 设置新值时也需要尝试转换， let a = ref(0);  a.value = 1
      raw = convert(newVal)
      // 触发 setter 操作
      trigger(v, OperationTypes.SET, '')
    }
  }
  return v as Ref<T>
}

// 如果有 _isRef 为 true 就表示是一个 Ref， let a = ref(0);  isRef(a) === true
export function isRef(v: any): v is Ref<any> {
  return v ? v._isRef === true : false
}

// const { foo, bar } = useFeatureX();  这种解构情况下会丢响应式， 所以应该在 useFeatureX 返回转换一下 toRefs(state)
export function toRefs<T extends object>(
  object: T
): { [K in keyof T]: Ref<T[K]> } {
  const ret: any = {}
  // 浅遍历
  for (const key in object) {
    // 转成 Ref 类型数据
    ret[key] = toProxyRef(object, key)
  }
  return ret
}

// 某个属性转成代理为 Ref
function toProxyRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): Ref<T[K]> {
  const v = {
    _isRef: true,
    get value() {
      return object[key]
    },
    set value(newVal) {
      object[key] = newVal
    }
  }
  return v as Ref<T[K]>
}

// 当值的类型为以下几种，将直接使用，值为 Object 或者 Array 继续递归
type BailTypes =
  | Function
  | Map<any, any>
  | Set<any>
  | WeakMap<any, any>
  | WeakSet<any>

// 递归的解开值， TS 没有能实现这种的递归操作， 所以手动写了 10 层大概来满足业务要求
// 划重点！！！ 只是类型推导， 不影响实际的运行。
// Recursively unwraps nested value bindings.
// Unfortunately TS cannot do recursive types, but this should be enough for
// practical use cases...
export type UnwrapRef<T> = T extends Ref<infer V>
  ? UnwrapRef2<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef2<V>>
    : T extends BailTypes
      ? T // bail out on types that shouldn't be unwrapped
      : T extends object ? { [K in keyof T]: UnwrapRef2<T[K]> } : T

type UnwrapRef2<T> = T extends Ref<infer V>
  ? UnwrapRef3<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef3<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef3<T[K]> } : T

type UnwrapRef3<T> = T extends Ref<infer V>
  ? UnwrapRef4<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef4<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef4<T[K]> } : T

type UnwrapRef4<T> = T extends Ref<infer V>
  ? UnwrapRef5<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef5<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef5<T[K]> } : T

type UnwrapRef5<T> = T extends Ref<infer V>
  ? UnwrapRef6<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef6<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef6<T[K]> } : T

type UnwrapRef6<T> = T extends Ref<infer V>
  ? UnwrapRef7<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef7<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef7<T[K]> } : T

type UnwrapRef7<T> = T extends Ref<infer V>
  ? UnwrapRef8<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef8<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef8<T[K]> } : T

type UnwrapRef8<T> = T extends Ref<infer V>
  ? UnwrapRef9<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef9<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef9<T[K]> } : T

type UnwrapRef9<T> = T extends Ref<infer V>
  ? UnwrapRef10<V>
  : T extends Array<infer V>
    ? Array<UnwrapRef10<V>>
    : T extends BailTypes
      ? T
      : T extends object ? { [K in keyof T]: UnwrapRef10<T[K]> } : T

type UnwrapRef10<T> = T extends Ref<infer V>
  ? V // stop recursion
  : T
