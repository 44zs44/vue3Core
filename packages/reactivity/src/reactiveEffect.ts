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
 * 查找与目标（或特定属性）关联的所有 deps 并
 * 触发其中存储的效果。
 *
 * @param target -反应对象。
 * @param type -定义需要触发效果的操作类型。
 * @param key -可用于定位目标对象中的特定反应属性。
 */
// 函数通过targetMap获取与目标对象相关联的依赖映射depsMap。如果depsMap不存在，说明该目标对象从未被追踪过，直接返回
//然后，函数创建一个空数组deps，用于存储要触发的依赖项。根据不同的操作类型，将不同的依赖项添加到deps数组中
//然后，函数调用pauseScheduling函数，暂停调度，避免触发副作用函数时再次调用track函数
//接着，函数遍历deps数组，对每个依赖项dep调用triggerEffects函数，触发依赖项dep中存储的副作用函数
//最后，函数调用resetScheduling函数，重置调度，恢复调度
// trigger函数：用于触发响应式对象上的依赖更新
export function trigger(
  target: object, // 目标对象，即响应式对象
  type: TriggerOpTypes, // 触发类型，如SET、ADD、DELETE等
  key?: unknown, // 被操作的属性键
  newValue?: unknown, // 新值，对于SET操作
  oldValue?: unknown, // 旧值，对于SET操作
  oldTarget?: Map<unknown, unknown> | Set<unknown>, // 仅对集合类型如Map/Set在清除操作时使用
) {
  // 从全局的targetMap中获取当前对象的依赖映射
  const depsMap = targetMap.get(target);
  // 如果当前对象没有依赖映射，即没有effect依赖于此对象的属性，直接返回
  if (!depsMap) {
    return;
  }

  // 初始化依赖数组，用于收集将要被触发的effect
  let deps: (Dep | undefined)[] = [];
  // 如果操作类型是CLEAR，说明是对集合类型进行了清空操作
  if (type === TriggerOpTypes.CLEAR) {
    // 触发该对象所有属性的effect
    deps = [...depsMap.values()];
  } else if (key === 'length' && isArray(target)) {
    // 如果操作是修改数组的length属性
    depsMap.forEach((dep, key) => {
      // 收集length属性的依赖，以及所有索引大于或等于新length值的数组元素的依赖
      if (key === 'length' || (!isSymbol(key) && key >= Number(newValue))) {
        deps.push(dep);
      }
    });
  } else {
    // 对于SET、ADD、DELETE操作
    if (key !== void 0) {
      // 收集被操作键的依赖
      deps.push(depsMap.get(key));
    }
    // 特殊处理对集合类型的操作
    switch (type) {
      case TriggerOpTypes.ADD:
        // 如果是向集合添加元素
        if (!isArray(target)) {
          // 对于非数组，触发ITERATE_KEY相关的effect
          deps.push(depsMap.get(ITERATE_KEY));
          if (isMap(target)) {
            // 对于Map，还需要触发MAP_KEY_ITERATE_KEY相关的effect
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY));
          }
        } else if (isIntegerKey(key)) {
          // 对于数组，如果添加的是索引（整数键），需要触发length属性的依赖
          deps.push(depsMap.get('length'));
        }
        break;
      case TriggerOpTypes.DELETE:
        // 如果是从集合中删除元素
        if (!isArray(target)) {
          // 触发ITERATE_KEY相关的effect
          deps.push(depsMap.get(ITERATE_KEY));
          if (isMap(target)) {
            // 对于Map，还需要触发MAP_KEY_ITERATE_KEY相关的effect
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY));
          }
        }
        break;
      case TriggerOpTypes.SET:
        // 对于Map的SET操作
        if (isMap(target)) {
          // 触发ITERATE_KEY相关的effect
          deps.push(depsMap.get(ITERATE_KEY));
        }
        break;
    }
  }

  // 暂停调度，这是一个优化步骤，避免在触发effect时立即执行，可以批量处理
  pauseScheduling();
  // 遍历deps数组，触发每个依赖的effect执行
  for (const dep of deps) {
    if (dep) {
      triggerEffects(
        dep,
        DirtyLevels.Dirty,
        // 传递额外的调试信息，如果是开发模式
        __DEV__ ? {
          target,
          type,
          key,
          newValue,
          oldValue,
          oldTarget,
        } : void 0,
      );
    }
  }
  // 重置调度状态，恢复到正常的调度逻辑
  resetScheduling();
}

export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
