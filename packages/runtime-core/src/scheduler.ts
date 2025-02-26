import { ErrorCodes, callWithErrorHandling, handleError } from './errorHandling'
import { type Awaited, NOOP, isArray } from '@vue/shared'
import { type ComponentInternalInstance, getComponentName } from './component'

/**
 * SchedulerJob 接口定义了可调度的任务
 */
export interface SchedulerJob extends Function {
  id?: number // 任务ID
  pre?: boolean // 是否为前置任务
  active?: boolean // 任务是否处于活动状态
  computed?: boolean // 是否为计算属性相关任务
  /**
   * 表示当该效果被调度器管理时，是否允许递归触发自身
   *
   * 默认情况下，一个任务不能触发自己，因为一些内置方法调用
   * 例如：Array.prototype.push 实际上也会进行读取操作（#1740），
   * 这可能会导致令人困惑的无限循环。
   *
   * 允许的情况是组件更新函数和侦听器回调：
   * - 组件更新函数可能会更新子组件的 props，这反过来会触发 flush: "pre" 的侦听器回调，
   *   从而改变父组件依赖的状态（#1801）
   * - 侦听器回调不会追踪其依赖，所以如果它再次触发自己，这可能是有意为之的，
   *   此时由用户负责确保递归状态修改最终能够稳定（#1727）
   */
  allowRecurse?: boolean

  /**
   * 由 renderer.ts 在设置组件的渲染效果时附加
   * 用于在报告最大递归更新时获取组件信息
   * 仅用于开发环境
   */
  ownerInstance?: ComponentInternalInstance
}

// SchedulerJobs 类型可以是单个任务或任务数组
export type SchedulerJobs = SchedulerJob | SchedulerJob[]

// 调度器状态标志
let isFlushing = false // 是否正在刷新队列
let isFlushPending = false // 是否有待处理的刷新

const queue: SchedulerJob[] = [] // 主任务队列
let flushIndex = 0 // 当前刷新的任务索引

const pendingPostFlushCbs: SchedulerJob[] = [] // 待处理的后置刷新回调队列
let activePostFlushCbs: SchedulerJob[] | null = null // 当前活动的后置刷新回调
let postFlushIndex = 0 // 后置刷新回调的处理索引

// 创建一个已解决的 Promise 实例，用于 nextTick 实现
const resolvedPromise = /*#__PURE__*/ Promise.resolve() as Promise<any>
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100 // 递归更新的最大限制次数
type CountMap = Map<SchedulerJob, number> // 用于追踪任务递归次数的 Map 类型

/**
 * nextTick - 在下一个 DOM 更新周期中执行回调函数
 * @param this - 回调函数的 this 上下文
 * @param fn - 要执行的回调函数
 * @returns Promise 对象，resolved 时执行回调
 */
export function nextTick<T = void, R = void>(
  this: T,
  fn?: (this: T) => R,
): Promise<Awaited<R>> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

/**
 * findInsertionIndex - 使用二分查找算法找到合适的插入位置
 * 用于维护队列中任务 ID 的递增顺序，可以防止任务被跳过并避免重复修补
 * @param id - 要插入的任务ID
 * @returns 适合插入的位置索引
 */
function findInsertionIndex(id: number) {
  // 起始索引应该是 `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)
    if (middleJobId < id || (middleJobId === id && middleJob.pre)) {
      start = middle + 1
    } else {
      end = middle
    }
  }

  return start
}

/**
 * queueJob - 将任务添加到队列中
 * @param job - 要添加的调度任务
 *
 * 该函数负责任务去重和队列管理：
 * - 使用 Array.includes() 的 startIndex 参数来实现去重搜索
 * - 默认搜索索引包含当前正在运行的任务，因此它不能再次递归触发自己
 * - 如果任务是 watch() 回调，搜索将从 +1 索引开始，允许其递归触发自身
 *   此时用户需要负责确保不会陷入无限循环
 */
export function queueJob(job: SchedulerJob) {
  if (
    !queue.length ||
    !queue.includes(
      job,
      isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex,
    )
  ) {
    if (job.id == null) {
      queue.push(job)
    } else {
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    queueFlush()
  }
}

/**
 * 每添加一个任务都会触发
 * queueFlush - 触发队列的刷新
 * 通过 Promise 微任务来异步执行队列中的任务
 */
function queueFlush() {
  //没有正在刷新队列且没有待处理的刷新
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

/**
 * invalidateJob - 使任务失效（从队列中移除）
 * @param job - 要移除的任务
 */
export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

/**
 * queuePostFlushCb - 将后置刷新回调添加到队列
 * @param cb - 要添加的回调函数或回调函数数组
 *
 * 如果回调是数组，表示这是组件生命周期钩子，它只能由任务触发
 * 且已经在主队列中去重，因此可以跳过重复检查以提高性能
 */
export function queuePostFlushCb(cb: SchedulerJobs) {
  if (!isArray(cb)) {
    if (
      !activePostFlushCbs ||
      !activePostFlushCbs.includes(
        cb,
        cb.allowRecurse ? postFlushIndex + 1 : postFlushIndex,
      )
    ) {
      pendingPostFlushCbs.push(cb)
    }
  } else {
    pendingPostFlushCbs.push(...cb)
  }
  queueFlush()
}

/**
 * flushPreFlushCbs - 刷新前置任务回调
 * @param instance - 组件实例
 * @param seen - 用于检测递归更新的 Map
 * @param i - 开始处理的索引，默认为当前 flushIndex + 1（如果正在刷新）
 */
export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,
  seen?: CountMap,
  i = isFlushing ? flushIndex + 1 : 0,) {
  if (__DEV__) {
    seen = seen || new Map()
  }
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.pre) {
      if (instance && cb.id !== instance.uid) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      cb()
    }
  }
}

/**
 * flushPostFlushCbs - 刷新后置任务回调队列
 * @param seen - 用于检测递归更新的 Map
 */
export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    // 对回调进行去重和排序
    const deduped = [...new Set(pendingPostFlushCbs)].sort(
      (a, b) => getId(a) - getId(b),
    )
    pendingPostFlushCbs.length = 0

    // #1947 如果已经有活动队列，说明是嵌套的 flushPostFlushCbs 调用
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 执行所有后置回调
    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

/**
 * getId - 获取任务的 ID
 * @param job - 调度任务
 * @returns 任务 ID，如果没有 ID 则返回 Infinity
 */
const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

/**
 * comparator - 任务比较函数，用于排序
 * @param a - 第一个任务
 * @param b - 第二个任务
 * @returns 比较结果
 *
 * 排序规则：
 * 1. 首先按 ID 排序
 * 2. ID 相同时，pre 标记的任务优先
 */
const comparator = (a: SchedulerJob, b: SchedulerJob): number => {
  const diff = getId(a) - getId(b)
  if (diff === 0) {
    if (a.pre && !b.pre) return -1
    if (b.pre && !a.pre) return 1
  }
  return diff
}

/**
 * flushJobs - 刷新任务队列
 * @param seen - 用于检测递归更新的 Map
 *
 * 该函数负责：
 * 1. 对队列进行排序，确保：
 *    - 组件更新从父到子进行（因为父组件总是在子组件之前创建）
 *    - 如果组件在父组件更新期间被卸载，其更新可以被跳过
 * 2. 执行队列中的所有任务
 * 3. 执行后置回调
 * 4. 处理可能在执行过程中新增的任务
 */
function flushJobs(seen?: CountMap) {
  isFlushPending = false
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // 在刷新前对队列进行排序
  queue.sort(comparator)

  // 在开发环境下检查递归更新
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 执行队列中的任务
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    flushIndex = 0
    queue.length = 0

    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // 如果队列中还有任务或者有待处理的后置回调
    // 继续刷新直到清空
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

/**
 * checkRecursiveUpdates - 检查递归更新
 * @param seen - 用于追踪任务执行次数的 Map
 * @param fn - 要检查的任务
 * @returns 如果超出递归限制则返回 true
 */
function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      handleError(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`,
        null,
        ErrorCodes.APP_ERROR_HANDLER,
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
