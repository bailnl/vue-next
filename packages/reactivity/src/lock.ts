// 此 flag 用于标记 readonly reactive 是否可以更新数据
// global immutability lock
export let LOCKED = true

export function lock() {
  LOCKED = true
}

export function unlock() {
  LOCKED = false
}
