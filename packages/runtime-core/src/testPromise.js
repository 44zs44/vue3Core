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
