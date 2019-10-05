import { OperationTypes } from './operations'
import { Dep, targetMap } from './reactive'
import { EMPTY_OBJ, extend } from '@vue/shared'

export interface ReactiveEffect {
  (): any
  isEffect: true
  active: boolean
  raw: Function
  deps: Array<Dep>
  computed?: boolean
  scheduler?: (run: Function) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  computed?: boolean
  scheduler?: (run: Function) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
}

export interface DebuggerEvent {
  effect: ReactiveEffect
  target: any
  type: OperationTypes
  key: string | symbol | undefined
}

export const activeReactiveEffectStack: ReactiveEffect[] = []

export const ITERATE_KEY = Symbol('iterate')

// 创建一个 effect
export function effect(
  fn: Function,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect {
  // 如果 fn 本就是一个 effect 函数 就取原始 fn，避免冲突
  if ((fn as ReactiveEffect).isEffect) {
    fn = (fn as ReactiveEffect).raw
  }
  // 创建一个 effect
  const effect = createReactiveEffect(fn, options)
  // 如果没有标记为 lazy， 说明不需要懒执行， 那么就立即执行
  if (!options.lazy) {
    effect()
  }
  // 返回 effect
  return effect
}

// 停止一个 effect
export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    // 清除依赖， 例如，effect(() => { console.log(obj.prop); }); 把 obj 的依赖中移除 effect
    cleanup(effect)
    // 如果有 onStop 就执行
    if (effect.onStop) {
      effect.onStop()
    }
    // 将 active 标记 为 false， 执行时不再为压入 activeReactiveEffectStack 中, 从此是一个普通的函数
    effect.active = false
  }
}

// 创建一个响应式的 effect
function createReactiveEffect(
  fn: Function,
  options: ReactiveEffectOptions
): ReactiveEffect {
  const effect = function effect(...args): any {
    return run(effect as ReactiveEffect, fn, args)
  } as ReactiveEffect
  effect.isEffect = true
  effect.active = true
  effect.raw = fn
  effect.scheduler = options.scheduler
  effect.onTrack = options.onTrack
  effect.onTrigger = options.onTrigger
  effect.onStop = options.onStop
  effect.computed = options.computed
  effect.deps = []
  return effect
}

function run(effect: ReactiveEffect, fn: Function, args: any[]): any {
  // 如果 active 为 false, 说明一个普通的函数
  if (!effect.active) {
    return fn(...args)
  }
  if (activeReactiveEffectStack.indexOf(effect) === -1) {
    // 清空依赖中的自己
    cleanup(effect)
    try {
      // 压入effectStack 栈中
      activeReactiveEffectStack.push(effect)
      // 当重新执行函数时会重新收集
      return fn(...args)
    } finally {
      // 无论如何都需要出栈
      activeReactiveEffectStack.pop()
    }
  }
}

// 清除依赖的自己
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true

// 暂停追踪
export function pauseTracking() {
  shouldTrack = false
}

// 恢复追踪
export function resumeTracking() {
  shouldTrack = true
}

// 依赖追踪
export function track(
  target: any,
  type: OperationTypes,
  key?: string | symbol
) {
  if (!shouldTrack) {
    return
  }
  // 取到 effect(副作用) 栈的最后一个
  const effect = activeReactiveEffectStack[activeReactiveEffectStack.length - 1]
  if (effect) {
    if (type === OperationTypes.ITERATE) {
      key = ITERATE_KEY
    }
    // 取得当前对象的所有属性的依赖表
    let depsMap = targetMap.get(target)
    // 如果没有就设置一个空的
    if (depsMap === void 0) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 找到当前key的依赖表
    let dep = depsMap.get(key!)
    // 如果没有就设置一个空的
    if (!dep) {
      depsMap.set(key!, (dep = new Set()))
    }
    // 如果当 effect 没有在依赖表里面
    if (!dep.has(effect)) {
      // 就把 effect 加入当前key的依赖表, 当对应的key 发生变化时，可以方便的找到相应的 effect
      dep.add(effect)
      // 反过来， effect 也需要知道依赖了谁。
      // 当重新执行 effect 的时候可以方便的找到 dep 里面的自己先移除掉，因为有可能就不再是依赖了。
      // 这样有一个好处 effect 不需要知道具体依赖的哪个属性。
      effect.deps.push(dep)
      // 开发模式下调用 onTrack 事件， 便于调试。
      if (__DEV__ && effect.onTrack) {
        effect.onTrack({
          effect,
          target,
          type,
          key
        })
      }
    }
  }
}

// 触发依赖处理
export function trigger(
  target: any,
  type: OperationTypes,
  key?: string | symbol,
  extraInfo?: any
) {
  // target 对象对应的 依赖表
  const depsMap = targetMap.get(target)
  // 如果没有就直接返回
  if (depsMap === void 0) {
    // never been tracked
    return
  }
  const effects: Set<ReactiveEffect> = new Set()
  const computedRunners: Set<ReactiveEffect> = new Set()
  if (type === OperationTypes.CLEAR) {
    // 当 集合被清除时，触发所有属性的 effect,  例如  let a = reactive(new Set(1, 2)); a.clear()
    // collection being cleared, trigger all effects for target
    depsMap.forEach(dep => {
      addRunners(effects, computedRunners, dep)
    })
  } else {
    // 收集某一个key 的 effect
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      addRunners(effects, computedRunners, depsMap.get(key))
    }
    // 如果 ADD | DELETE 操作也应该要触发集合/数组的 length/ITERATE_KEY 的 effect， 所以得收集一波。
    // also run for iteration key on ADD | DELETE
    if (type === OperationTypes.ADD || type === OperationTypes.DELETE) {
      const iterationKey = Array.isArray(target) ? 'length' : ITERATE_KEY
      addRunners(effects, computedRunners, depsMap.get(iterationKey))
    }
  }
  // 触发 effect
  const run = (effect: ReactiveEffect) => {
    scheduleRun(effect, target, type, key, extraInfo)
  }

  // 重要！！！！ 必须先运行 computed 的 effect, 运行正常的 effect 之前使 computed getter 失效
  // Important: computed effects must be run first so that computed getters
  // can be invalidated before any normal effects that depend on them are run.
  computedRunners.forEach(run)
  effects.forEach(run)
}

function addRunners(
  effects: Set<ReactiveEffect>,
  computedRunners: Set<ReactiveEffect>,
  effectsToAdd: Set<ReactiveEffect> | undefined
) {
  if (effectsToAdd !== void 0) {
    effectsToAdd.forEach(effect => {
      // 判断是否为 computed 属性，否则是普通的 effect
      if (effect.computed) {
        computedRunners.add(effect)
      } else {
        effects.add(effect)
      }
    })
  }
}

// 处理 effect 运行
function scheduleRun(
  effect: ReactiveEffect,
  target: any,
  type: OperationTypes,
  key: string | symbol | undefined,
  extraInfo: any
) {
  // 开发模式下触发 onTrigger
  if (__DEV__ && effect.onTrigger) {
    effect.onTrigger(
      extend(
        {
          effect,
          target,
          key,
          type
        },
        extraInfo
      )
    )
  }
  // effect 自定义调度器
  if (effect.scheduler !== void 0) {
    effect.scheduler(effect)
  } else {
    effect()
  }
}
