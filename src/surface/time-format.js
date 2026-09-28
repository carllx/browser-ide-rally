/**
 * 诚实相对观察时间格式化模块 (Honest Observation Time Formatter)
 *
 * 规范约束 (#26):
 * 1. 忠实呈现相对观察时间，不伪造即时精确性；
 * 2. 避免误导性 wording，明确表明为观察时间（如“观察于 X 分钟前”）；
 * 3. 精确 ISO 时间戳作为元数据保留在属性或 Details 中供机器与诊断读取。
 */

/**
 * 格式化 ISO 时间戳为相对观察时间说明
 * @param {string|null|undefined} isoString - ISO 格式时间字符串
 * @param {number} [now=Date.now()] - 当前参考时间戳 (毫秒)
 * @returns {{ text: string, iso: string|null }} 相对时间文案与原始 ISO 字符串
 */
export function formatHonestObservationTime(isoString, now = Date.now()) {
  if (!isoString) {
    return { text: '暂无可靠观察时间', iso: null };
  }

  const date = new Date(isoString);
  const time = date.getTime();
  if (Number.isNaN(time)) {
    return { text: '观察时间无效', iso: null };
  }

  const diffMs = now - time;
  // 容许极微小本地时钟偏差 (30 秒以内)，超过此范围的未来时间属于异常时间戳
  const MAX_FUTURE_TOLERANCE_MS = 30 * 1000;
  if (diffMs < -MAX_FUTURE_TOLERANCE_MS) {
    return { text: '观察时间异常 / 待核验', iso: isoString };
  }

  // 轻微时钟偏差或 1 分钟内的正常即时观察
  if (diffMs < 60 * 1000) {
    return { text: '刚刚观察到', iso: isoString };
  }

  const diffMinutes = Math.floor(diffMs / (60 * 1000));
  if (diffMinutes < 60) {
    return { text: `观察于 ${diffMinutes} 分钟前`, iso: isoString };
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return { text: `观察于 ${diffHours} 小时前`, iso: isoString };
  }

  const diffDays = Math.floor(diffHours / 24);
  return { text: `观察于 ${diffDays} 天前`, iso: isoString };
}
