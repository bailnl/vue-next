import { effect, ReactiveEffect, activeReactiveEffectStack } from './effect'
import { Ref, UnwrapNestedRefs } from './ref'
import { isFunction } from '@vue/shared'

export interface ComputedRef<T> extends Ref<T> {
  readonly value: UnwrapNestedRefs<T>
  readonly effect: ReactiveEffect
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect
}

export interface WritableComputedOptions<T> {
  get: () => T
  set: (v: T) => void
}

export function computed<T>(getter: () => T): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: (() => T) | WritableComputedOptions<T>
): any {
  const isReadonly = isFunction(getterOrOptions)
  const getter = isReadonly
    ? (getterOrOptions as (() => T))
    : (getterOrOptions as WritableComputedOptions<T>).get
  const setter = isReadonly
    ? null
    : (getterOrOptions as WritableComputedOptions<T>).set

  // 默认标记为 dirty， 这样第一次取值的时候就会计算。
  let dirty: boolean = true
  let value: any = undefined

  const runner = effect(getter, {
    // 标记为 lazy，不立即执行
    lazy: true,
    // 标记为 computed 在 trigger 阶段优先级更高
    // mark effect as computed so that it gets priority during trigger
    computed: true,
    scheduler: () => {
      // 标记为脏，取值时会重新计算
      dirty = true
    }
  })
  return {
    // 标记为 Ref 类型
    _isRef: true,
    // 导出 effect 可以用停止（stop） computed 属性
    // expose effect so computed can be stopped
    effect: runner,
    get value() {
      // 当标记为 脏的时候重新取值，并置回状态
      if (dirty) {
        value = runner()
        dirty = false
      }
      // 当 parent effect 访问 computed effect 时, parent 应该追踪 computed 所有的依赖项
      // When computed effects are accessed in a parent effect, the parent
      // should track all the dependencies the computed property has tracked.
      // This should also apply for chained computed properties.
      trackChildRun(runner)
      return value
    },
    set value(newValue) {
      // 调用自定义 setter
      if (setter) {
        setter(newValue)
      } else {
        // TODO warn attempting to mutate readonly computed value
      }
    }
  }
}

function trackChildRun(childRunner: ReactiveEffect) {
  const parentRunner =
    activeReactiveEffectStack[activeReactiveEffectStack.length - 1]
  if (parentRunner) {
    for (let i = 0; i < childRunner.deps.length; i++) {
      const dep = childRunner.deps[i]
      if (!dep.has(parentRunner)) {
        dep.add(parentRunner)
        parentRunner.deps.push(dep)
      }
    }
  }
}
