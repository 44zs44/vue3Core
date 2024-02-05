import {
  type Target,
  isReadonly,
  isShallow,
  reactive,
  reactiveMap,
  readonly,
  readonlyMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  toRaw,
} from './reactive'
import { ReactiveFlags, TrackOpTypes, TriggerOpTypes } from './constants'
import {
  pauseScheduling,
  pauseTracking,
  resetScheduling,
  resetTracking,
} from './effect'
import { ITERATE_KEY, track, trigger } from './reactiveEffect'
import {
  hasChanged,
  hasOwn,
  isArray,
  isIntegerKey,
  isObject,
  isSymbol,
  makeMap,
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol),
)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      pauseTracking()
      pauseScheduling()
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetScheduling()
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function hasOwnProperty(this: object, key: string) {
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key)
}

class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false, // 是否只读
    protected readonly _shallow = false, // 是否浅响应式
  ) {}

  get(target: Target, key: string | symbol, receiver: object) {
    // 特殊响应式标志处理
    const isReadonly = this._isReadonly,
      shallow = this._shallow
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (key === ReactiveFlags.RAW) {
      // 返回原始对象的逻辑判断
      return target
    }

    const targetIsArray = isArray(target) // 判断目标是否为数组

    // 数组特殊处理逻辑
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }
    if (key === 'hasOwnProperty') {
      return hasOwnProperty
    }

    const res = Reflect.get(target, key, receiver) // 常规属性获取

    // 跳过对特殊键和非跟踪键的处理
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 依赖收集
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 浅响应式直接返回结果
    if (shallow) {
      return res
    }

    // Ref解包逻辑
    if (isRef(res)) {
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    // 深响应式转换逻辑
    if (isObject(res)) {
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res // 返回最终结果
  }
}

// 定义一个MutableReactiveHandler类，继承自BaseReactiveHandler
class MutableReactiveHandler extends BaseReactiveHandler {
  // 构造函数，接收一个可选的shallow参数，默认值为false
  constructor(shallow = false) {
    // 调用父类的构造函数，传递false和shallow参数
    super(false, shallow)
  }

  // set方法用于拦截对对象属性的设置操作
  set(
    target: object, // 目标对象
    key: string | symbol, // 属性键
    value: unknown, // 设置的值
    receiver: object, // 代理对象
  ): boolean {
    let oldValue = (target as any)[key] // 获取旧值
    // 如果不是浅响应式处理
    if (!this._shallow) {
      const isOldValueReadonly = isReadonly(oldValue) // 检查旧值是否为只读
      // 如果新值不是浅响应式，并且不是只读的，转换旧值和新值为原始对象
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 如果目标不是数组，并且旧值是ref而新值不是ref
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        if (isOldValueReadonly) {
          // 如果旧值是只读的，不允许修改，返回false
          return false
        } else {
          // 否则更新旧ref的值为新值
          oldValue.value = value
          return true
        }
      }
    } // 如果是浅响应式，这里不做额外处理，直接设置新值

    // 检查属性是否已存在
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    // 使用Reflect.set设置属性值
    const result = Reflect.set(target, key, value, receiver)
    // 如果目标对象就是原始接收对象
    if (target === toRaw(receiver)) {
      // 如果是新添加的属性
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value) // 触发添加操作的响应
      } else if (hasChanged(value, oldValue)) {
        // 如果值发生了变化
        trigger(target, TriggerOpTypes.SET, key, value, oldValue) // 触发设置操作的响应
      }
    }
    return result // 返回操作的结果
  }

  // deleteProperty方法用于拦截对象属性的删除操作
  deleteProperty(target: object, key: string | symbol): boolean {
    const hadKey = hasOwn(target, key) // 检查属性是否存在
    const oldValue = (target as any)[key] // 获取旧值
    const result = Reflect.deleteProperty(target, key) // 删除属性
    if (result && hadKey) {
      // 如果删除成功且属性确实存在，触发删除操作的响应
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result // 返回操作的结果
  }

  // has方法用于拦截属性检查操作
  has(target: object, key: string | symbol): boolean {
    const result = Reflect.has(target, key) // 检查属性是否存在
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      // 如果不是内建符号，追踪依赖
      track(target, TrackOpTypes.HAS, key)
    }
    return result // 返回检查的结果
  }

  // ownKeys方法用于拦截对象键的获取操作
  ownKeys(target: object): (string | symbol)[] {
    // 追踪迭代操作依赖
    track(
      target,
      TrackOpTypes.ITERATE,
      isArray(target) ? 'length' : ITERATE_KEY,
    )
    // 获取并返回对象的所有自有键
    return Reflect.ownKeys(target)
  }
}

class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(true, shallow)
  }

  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }

  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target,
      )
    }
    return true
  }
}

export const mutableHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new MutableReactiveHandler()

export const readonlyHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new ReadonlyReactiveHandler()

export const shallowReactiveHandlers = /*#__PURE__*/ new MutableReactiveHandler(
  true,
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers =
  /*#__PURE__*/ new ReadonlyReactiveHandler(true)
