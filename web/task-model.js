export const GOALS = {research:'调研查证',analysis:'分析决策',content:'内容创作',build:'制作执行'};
export const COLLABORATION = {open:'自主认领协作',hosted:'主持分工'};
export const SCHEDULES = {once:'一次性',recurring:'定期执行',event:'事件触发'};
export const legacyGoal = type => ({data:'analysis',creative:'content',debate:'analysis'}[type] || 'research');
export const legacyType = goal => ({analysis:'data',content:'creative',build:'research',research:'research'}[goal]);
export function acceptanceTemplate(goal) {
  return {criteria:'',min_sources:goal==='analysis'?2:goal==='research'?1:0,independent_review:goal!=='content',opposing_views:false};
}
