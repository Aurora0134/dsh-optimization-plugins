/**
 * 「这个 run 还能不能续跑」的唯一判定（§1.1(1) `resumable`，ZCode `SRt`）。
 *
 * 只有用户主动停下、且不是被 amend 顶替的 run 才能续跑：被 superseded 的 run 已经有后续
 * run，前端不能再给它「续跑」入口，否则按钮必然被 runtime 拒绝。抽成共享函数是为了让
 * store 摘要、投影摘要和 HTTP 层不会各写一份而漂移。
 */

/**
 * @param {unknown} status run 状态
 * @param {unknown} stopReason stopped 的原因
 * @returns {boolean}
 */
export function isResumable(status, stopReason) {
  return status === 'stopped' && stopReason !== 'superseded';
}
