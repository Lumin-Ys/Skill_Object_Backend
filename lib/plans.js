/**
 * Skill 套餐定义
 *
 * 注册只创建账号，不会签发 Skill Token。
 * 购买套餐并仍在有效期内，才允许使用 Skill / 发起部署。
 */

const PLANS = {
  starter: {
    id: 'starter',
    name: '入门版',
    price: 29,
    period: 'month',
    days: 30,
    deploys: 20,
    tag: '',
    desc: '个人试用，每月 20 次部署',
    features: ['20 次部署 / 月', '风险扫描', '专属测试域名', '1 个工作区'],
  },
  pro: {
    id: 'pro',
    name: '专业版',
    price: 99,
    period: 'month',
    days: 30,
    deploys: -1,
    tag: '推荐',
    desc: '独立开发者与小团队日常上线',
    features: ['不限次数部署', '风险扫描', '专属测试域名', '优先队列', '任务历史保留'],
  },
  team: {
    id: 'team',
    name: '团队版',
    price: 299,
    period: 'month',
    days: 30,
    deploys: -1,
    tag: '',
    desc: '团队协作与高频交付',
    features: ['不限次数部署', '多成员席位（即将开放）', '审计日志', '专属域名', '工单支持'],
  },
};

function listPlans() {
  return Object.values(PLANS);
}

function getPlan(id) {
  return PLANS[id] || null;
}

module.exports = { PLANS, listPlans, getPlan };
