import { NOOP, extend } from '@vue/shared'
import type { ComputedRefImpl } from './computed'
import {
  DirtyLevels,
  type TrackOpTypes,
  type TriggerOpTypes,
} from './constants'
import type { Dep } from './dep'
import { type EffectScope, recordEffectScope } from './effectScope'

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

export let activeEffect: ReactiveEffect | undefined

// 1.追踪和管理依赖关系：ReactiveEffect实例会追踪函数(fn)执行过程中所访问的响应式数据（依赖）。
//   这些依赖被收集起来，以便在数据更新时能够重新执行这个函数，从而触发视图更新或执行其他副作用。
// 2.控制执行逻辑：通过active属性管理其激活状态，以及通过run方法控制副作用函数的执行，包括处理依赖追踪和清理工作。这样可以优化性能，避免不必要的计算或更新。
// 3.支持计算属性和观察者模式：ReactiveEffect可以作为计算属性(computed)的基础设施，支持对计算结果的缓存和有效的重新计算策略。
//   此外，它还可以作为响应式系统中的观察者，响应数据的变化。
// 4.提供生命周期钩子和调试支持：通过onStop、onTrack和onTrigger等钩子函数，ReactiveEffect允许开发者在副作用的不同阶段插入自定义逻辑，用于调试或扩展功能。
// 5.优化和状态管理：内部属性如_dirtyLevel和_depsLength用于管理和优化副作用的执行，例如避免不必要的重新计算，并且通过dirty的getter和setter控制计算属性的缓存逻辑。
export class ReactiveEffect<T = any> {
  // 表示此效果是否处于活动状态，默认为true
  active = true
  // 依赖数组，存储此效果依赖的所有响应式对象
  deps: Dep[] = []

  // 可选属性，计算属性实现，如果效果用于计算属性，则会设置此属性
  /**
   * @internal
   */
  computed?: ComputedRefImpl<T>
  // 可选属性，允许递归触发效果
  /**
   * @internal
   */
  allowRecurse?: boolean

  // 当停止响应式效果时调用的回调函数
  onStop?: () => void
  // 仅开发模式下使用，追踪依赖时调用的回调函数
  onTrack?: (event: DebuggerEvent) => void
  // 仅开发模式下使用，触发更新时调用的回调函数
  onTrigger?: (event: DebuggerEvent) => void

  // 表示效果的脏状态，用于优化计算属性的重新计算
  /**
   * @internal
   */
  _dirtyLevel = DirtyLevels.Dirty
  // 用于追踪优化，内部使用
  /**
   * @internal
   */
  _trackId = 0
  // 当前正在运行的此效果的数量，用于递归调用的管理
  /**
   * @internal
   */
  _runnings = 0
  // 表示是否应该调度此效果的更新
  /**
   * @internal
   */
  _shouldSchedule = false
  // 依赖数组的长度，内部使用
  /**
   * @internal
   */
  _depsLength = 0

  // 类构造函数，接收四个参数：fn是效果函数，trigger是触发更新的函数，scheduler是调度器，scope是效果作用域
  constructor(
    public fn: () => T, // 效果函数，返回泛型T的值
    public trigger: () => void, // 触发更新的函数
    public scheduler?: EffectScheduler, // 可选的调度器，用于自定义效果的调度方式
    scope?: EffectScope, // 可选的效果作用域
  ) {
    recordEffectScope(this, scope) // 将效果记录到其作用域
  }

  // 获取效果是否脏（需要重新计算）的属性
  public get dirty() {
    if (this._dirtyLevel === DirtyLevels.MaybeDirty) {
      pauseTracking() // 暂停追踪
      for (let i = 0; i < this._depsLength; i++) {
        const dep = this.deps[i]
        if (dep.computed) {
          triggerComputed(dep.computed) // 触发计算属性的更新
          if (this._dirtyLevel >= DirtyLevels.Dirty) {
            break // 如果效果变脏，则跳出循环
          }
        }
      }
      if (this._dirtyLevel < DirtyLevels.Dirty) {
        this._dirtyLevel = DirtyLevels.NotDirty // 更新脏状态
      }
      resetTracking() // 重置追踪状态
    }
    return this._dirtyLevel >= DirtyLevels.Dirty // 返回是否脏
  }

  /*
  "dirtyLevel"是用于跟踪组件的状态是否发生了变化的一个标志。它用于确定何时需要重新渲染组件
  "dirtyLevel"有以下几个取值：
      DirtyLevels.NotDirty：表示组件状态是干净的，没有发生任何变化。
      DirtyLevels.MaybeDirty：表示组件状态没有发生变化，但是可能存在子组件的状态发生了变化。
      DirtyLevels.Dirty：表示组件状态已经发生了变化，需要重新渲染。
  当组件的状态发生变化时，Vue 3会将"dirtyLevel"设置为DirtyLevels.Dirty，
  这样在下一次渲染时，Vue 3会重新计算组件的虚拟DOM，并将其与之前的虚拟DOM进行对比，找出需要更新的部分进行局部更新。
 */
  public set dirty(v) {
    this._dirtyLevel = v ? DirtyLevels.Dirty : DirtyLevels.NotDirty
  }

  // 运行效果函数
  run() {
    this._dirtyLevel = DirtyLevels.NotDirty // 将脏状态设置为不脏
    if (!this.active) {
      return this.fn() // 如果效果不活动，则直接运行效果函数
    }
    let lastShouldTrack = shouldTrack // 保存当前的追踪状态
    let lastEffect = activeEffect // 保存当前活动的效果
    try {
      shouldTrack = true // 开启追踪
      activeEffect = this // 设置当前效果为活动效果
      this._runnings++ // 增加运行次数
      preCleanupEffect(this) // 效果运行前的清理工作
      return this.fn() // 运行效果函数
    } finally {
      postCleanupEffect(this) // 效果运行后的清理工作
      this._runnings-- // 减少运行次数
      activeEffect = lastEffect // 恢复之前的活动效果
      shouldTrack = lastShouldTrack // 恢复追踪状态
    }
  }

  // 停止效果
  stop() {
    if (this.active) {
      preCleanupEffect(this) // 停止前的清理工作
      postCleanupEffect(this) // 停止后的清理工作
      this.onStop?.() // 调用停止回调函数
      this.active = false // 设置效果为不活动
    }
  }
}

function triggerComputed(computed: ComputedRefImpl<any>) {
  return computed.value
}

function preCleanupEffect(effect: ReactiveEffect) {
  effect._trackId++
  effect._depsLength = 0
}

function postCleanupEffect(effect: ReactiveEffect) {
  if (effect.deps && effect.deps.length > effect._depsLength) {
    for (let i = effect._depsLength; i < effect.deps.length; i++) {
      cleanupDepEffect(effect.deps[i], effect)
    }
    effect.deps.length = effect._depsLength
  }
}

function cleanupDepEffect(dep: Dep, effect: ReactiveEffect) {
  const trackId = dep.get(effect)
  if (trackId !== undefined && effect._trackId !== trackId) {
    dep.delete(effect)
    if (dep.size === 0) {
      dep.cleanup()
    }
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

/**
 * Registers the given function to track reactive updates.
 *
 * The given function will be run once immediately. Every time any reactive
 * property that's accessed within it gets updated, the function will run again.
 *
 * @param fn - The function that will track reactive updates.
 * @param options - Allows to control the effect's behaviour.
 * @returns A runner that can be used to control the effect after creation.
 */
// effect函数用于创建一个响应式的副作用。它接受一个函数fn和一个可选的配置对象options。
export function effect<T = any>(
  // fn是当响应式对象发生变化时需要执行的函数。
  fn: () => T,
  // options是一个可选参数，用于配置副作用的行为。
  options?: ReactiveEffectOptions,
): ReactiveEffectRunner {
  // 如果传入的fn已经是一个ReactiveEffectRunner的实例，那么将使用它内部的fn函数。
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建一个ReactiveEffect实例。ReactiveEffect是一个类，用于封装副作用函数和其行为。
  const _effect = new ReactiveEffect(fn, NOOP, () => {
    // 如果_effect标记为dirty，则再次执行它。
    if (_effect.dirty) {
      _effect.run()
    }
  })

  // 如果提供了options，则将这些选项合并到_effect实例中。
  if (options) {
    extend(_effect, options)
    // 如果options中指定了scope，则将_effect记录到相应的作用域中。
    if (options.scope) recordEffectScope(_effect, options.scope)
  }

  // 如果没有指定lazy选项或者lazy为false，则立即执行_effect。
  if (!options || !options.lazy) {
    _effect.run()
  }

  // runner是_effect.run方法的绑定版本，用于外部调用。
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  // 将_effect实例附加到runner上，以便外部可以访问。
  runner.effect = _effect

  // 返回runner，这是一个函数，可以用于手动控制副作用的执行。
  return runner
}


/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true
export let pauseScheduleStack = 0

const trackStack: boolean[] = []

/**
 * Temporarily pauses tracking.
 */
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

export function pauseScheduling() {
  pauseScheduleStack++
}

export function resetScheduling() {
  pauseScheduleStack--
  while (!pauseScheduleStack && queueEffectSchedulers.length) {
    queueEffectSchedulers.shift()!()
  }
}
/*
effect 是一个 ReactiveEffect 类型的对象，表示一个响应式副作用。响应式副作用是一个函数，它会在依赖项发生变化时被触发执行。在这个函数中，你可以执行任何需要响应式数据的操作。
dep 是一个 Dep 类型的对象，表示一个依赖集合。依赖集合用于跟踪响应式副作用所依赖的数据。当依赖项发生变化时，依赖集合会通知相关的响应式副作用进行更新。
在 trackEffect 函数中，我们首先检查该副作用是否已经被该依赖集合追踪。如果没有被追踪，则将副作用添加到依赖集合中，并更新副作用的追踪标识。
然后，我们会将当前依赖集合添加到副作用的依赖数组中。如果依赖集合已经存在于依赖数组中，则只会增加依赖计数。
这样做的目的是为了确保每个副作用都能正确地跟踪它所依赖的数据，并在依赖项发生变化时进行更新。 
 */
export function trackEffect(
  effect: ReactiveEffect,
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo,
) {
  // 检查该副作用是否已经被该依赖集合追踪
  if (dep.get(effect) !== effect._trackId) {
    // 如果未追踪，则将副作用添加到依赖集合中，并更新副作用的追踪标识
    dep.set(effect, effect._trackId)
    const oldDep = effect.deps[effect._depsLength]
    if (oldDep !== dep) {
      if (oldDep) {
        cleanupDepEffect(oldDep, effect)
      }
      // 将当前依赖集合添加到副作用的依赖数组中
      effect.deps[effect._depsLength++] = dep
    } else {
      // 如果依赖集合相同，则只增加依赖计数
      effect._depsLength++
    }
    // 如果是开发模式，则调用 onTrack 回调，提供副作用追踪的详细信息
    if (__DEV__) {
      effect.onTrack?.(extend({ effect }, debuggerEventExtraInfo!))
    }
  }
}

const queueEffectSchedulers: EffectScheduler[] = []

//遍历给定的依赖项（通常是一个响应式属性或对象所关联的副作用函数集合），并根据脏级别和其他条件决定是否需要触发和调度这些副作用
export function triggerEffects(
  dep: Dep, // 依赖项
  dirtyLevel: DirtyLevels, // 脏级别，表示数据的变化程度
  debuggerEventExtraInfo?: DebuggerEventExtraInfo, // 调试器事件的额外信息
) {
  // 暂停调度，防止在触发效果时进行其他调度
  pauseScheduling()
  // 遍历依赖项的所有效果
  for (const effect of dep.keys()) {
    // 如果效果的脏级别小于传入的脏级别，并且依赖项中的效果ID等于效果的跟踪ID
    if (
      effect._dirtyLevel < dirtyLevel &&
      dep.get(effect) === effect._trackId
    ) {
      const lastDirtyLevel = effect._dirtyLevel // 保存旧的脏级别
      effect._dirtyLevel = dirtyLevel // 更新脏级别

      // 如果旧的脏级别是“不脏”，则应该调度效果
      if (lastDirtyLevel === DirtyLevels.NotDirty) {
        effect._shouldSchedule = true // 设置应该调度效果

        // 如果是开发模式，触发效果的onTrigger事件
        if (__DEV__) {
          effect.onTrigger?.(extend({ effect }, debuggerEventExtraInfo))
        }
        effect.trigger() // 触发效果
      }
    }
  }

  scheduleEffects(dep) // 调度依赖项的效果
  resetScheduling() // 重置调度状态
}

export function scheduleEffects(dep: Dep) {
  for (const effect of dep.keys()) {
    if (
      effect.scheduler &&
      effect._shouldSchedule &&
      (!effect._runnings || effect.allowRecurse) &&
      dep.get(effect) === effect._trackId
    ) {
      effect._shouldSchedule = false
      queueEffectSchedulers.push(effect.scheduler)
    }
  }
}
