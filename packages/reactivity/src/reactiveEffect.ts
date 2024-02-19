import { isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import { DirtyLevels, type TrackOpTypes, TriggerOpTypes } from './constants'
import { type Dep, createDep } from './dep'
import {
  activeEffect,
  pauseScheduling,
  resetScheduling,
  shouldTrack,
  trackEffect,
  triggerEffects,
} from './effect'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Maps to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<object, KeyToDepMap>()

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

/**
 * 跟踪对反应性属性的访问。
 *
 * 这将检查当前正在运行哪个效果并将其记录为 dep
 * 它记录了依赖于反应性属性的所有效果。
 * @param target -持有反应属性的对象。
 * @param type -定义对反应性属性的访问类型。
 * @param key -要跟踪的反应性属性的标识符。
 */
// 定义一个函数`track`，用于跟踪一个对象的属性被副作用函数依赖的关系。
// 在一个全局的targetMap中记录哪些响应式对象（target）的哪些属性（key）被哪些副作用函数（activeEffect）所依赖
// 当响应式对象的属性发生变化时，可以快速找到依赖这个属性的所有副作用函数并执行它们
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果`shouldTrack`（是否应该跟踪）和`activeEffect`（当前激活的副作用函数）都存在，
  // 则说明现在是在收集依赖的过程中。
  if (shouldTrack && activeEffect) {
    // 尝试从`targetMap`（全局的目标对象到依赖映射的Map）中获取当前对象`target`对应的依赖映射Map。
    let depsMap = targetMap.get(target)
    // 如果不存在，则为这个对象创建一个新的Map，并将其设置到`targetMap`中。
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 尝试从`depsMap`中获取当前属性`key`对应的依赖集合`dep`。
    let dep = depsMap.get(key)
    // 如果不存在，则创建一个新的依赖集合，并设置到`depsMap`中。
    // `createDep`是一个创建依赖集合的函数，它可能会接收一个回调函数用于依赖集合被清理时的操作。
    if (!dep) {
      depsMap.set(key, (dep = createDep(() => depsMap!.delete(key))))
    }
    // 调用`trackEffect`函数，将当前的副作用函数`activeEffect`添加到这个属性的依赖集合`dep`中。
    // 如果是开发模式（`__DEV__`为真），则传递额外的调试信息，包括目标对象、操作类型和属性键。
    // 否则，传递`undefined`作为第三个参数。
    trackEffect(
      activeEffect,
      dep,
      __DEV__
        ? {
            target,
            type,
            key,
          }
        : void 0,
    )
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 *
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>,
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    const newLength = Number(newValue)
    depsMap.forEach((dep, key) => {
      if (key === 'length' || (!isSymbol(key) && key >= newLength)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  pauseScheduling()
  for (const dep of deps) {
    if (dep) {
      triggerEffects(
        dep,
        DirtyLevels.Dirty,
        __DEV__
          ? {
              target,
              type,
              key,
              newValue,
              oldValue,
              oldTarget,
            }
          : void 0,
      )
    }
  }
  resetScheduling()
}

export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
