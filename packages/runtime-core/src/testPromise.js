/*
let currentPromise = null
function flushTasks() {
    console.log('执行 flushTasks')
    return '完成'
}

function test() {
    console.log('开始')
    const resolvedPromise = Promise.resolve()

    resolvedPromise.then(() => {
        console.log('微任务 #1: resolvedPromise.then')
    })

    currentPromise = resolvedPromise.then(flushTasks)

    currentPromise.then(result => {
        console.log('微任务 #2: currentPromise.then -', result)
    })

    currentPromise
        .then(result => {
            console.log('微任务 #3: 第一个链式then -', result)
            Promise.resolve().then(() => {
                console.log('微任务3中的微任务')
            })
            setTimeout(() => {
                console.log('微任务3后的宏任务: setTimeout')
            }, 0)
            return '链式调用1'
        })
        .then(result => {
            console.log('微任务 #4: 第二个链式then -', result)
            return '链式调用2'
        })

    Promise.resolve().then(() => {
        console.log('微任务 #5: 新的Promise.resolve')
        setTimeout(() => {
            console.log('微任务5后的宏任务: setTimeout')
        }, 0)
    })

    console.log('同步代码结束')
}

test()
*/

const resolvedPromise = Promise.resolve();
let count = 0;

// 第一次注册 nextTick
resolvedPromise.then(() => {
    console.log('callback before', count);
}).then(() => {
    console.log('promise before1', count);
});

// 执行 this.count++
// 这里会触发 queueJob 方法，将任务添加到任务队列中
const currentFlushPromise = resolvedPromise.then(() => {
    count++;
    console.log('render', count);
});

// 第二次注册 nextTick
currentFlushPromise.then(() => {
    console.log('callback after', count);
}).then(() => {
    console.log('promise after', count);
});
