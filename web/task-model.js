export const GOALS = {research:'调研查证',analysis:'分析决策',content:'内容创作',build:'制作执行',active_debate:'激辩'};
export const COLLABORATION = {open:'自主认领协作',hosted:'主持分工'};
export const SCHEDULES = {once:'一次性',recurring:'定期执行',event:'事件触发'};
export const legacyGoal = type => ({data:'analysis',creative:'content',debate:'analysis',active_debate:'active_debate'}[type] || 'research');
export const legacyType = goal => ({analysis:'data',content:'creative',build:'research',research:'research',active_debate:'active_debate'}[goal]);
export function acceptanceTemplate(goal) {
  if(goal==='active_debate') return {criteria:'主动提出观点，接续反驳与追问，持续讨论至截止时间；到期总结观点与分歧。',min_sources:0,independent_review:false,opposing_views:true};
  return {criteria:'',min_sources:goal==='analysis'?2:goal==='research'?1:0,independent_review:goal!=='content',opposing_views:false};
}
