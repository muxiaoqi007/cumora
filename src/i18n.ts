/**
 * Lightweight UI locale. This fork defaults to Simplified Chinese.
 * Keys are stable English identifiers; missing keys fall back to English.
 */
export type Locale = 'zh-Hans' | 'en'

const STORAGE_KEY = 'cumora.locale'

const zhHans: Record<string, string> = {
  'rail.conversations': '会话',
  'rail.whispers': '密语',
  'rail.ship': '交付',
  'rail.boards': '看板',
  'rail.calendar': '日历',
  'rail.docs': '文档',
  'rail.agents': '智能体',
  'rail.me': '我',
  'rail.observe': '观测',
  'rail.signOut': '退出登录',
  'rail.you': '我',
  'rail.daemonOutdated': '有电脑的守护进程需要更新 — 打开「我」',

  'convos.title': '会话',
  'convos.newGroup': '新建群聊',
  'convos.newEmail': '写邮件',
  'convos.search': '搜索会话、智能体或成员…',
  'convos.clearSearch': '清除搜索',
  'convos.filter.all': '全部',
  'convos.filter.unread': '未读',
  'convos.filter.agents': '智能体',
  'convos.filter.humans': '成员',
  'convos.filter.groups': '群组',
  'convos.filter.email': '邮件',
  'convos.filter.whispers': '密语',
  'convos.searching': '搜索中…',
  'convos.done': '完成',
  'convos.emailThread': '邮件线程',

  'chat.send': '发送',
  'chat.placeholder': '给团队发消息。输入 @ 召唤，拖入文件即可附件。',
  'chat.beginning': '开始',
  'chat.convene': '召集',
  'chat.comingSoon': '即将推出',
  'chat.setTopic': '设置主题',
  'chat.clickTopic': '点击编辑主题',
  'chat.members': '查看会话成员',
  'chat.searchIn': '在此会话中搜索',
  'chat.searchInPh': '在此会话中搜索…',
  'chat.attach': '添加附件',
  'chat.mention': '提及',
  'chat.emoji': '表情',
  'chat.removeAttachment': '移除附件',
  'chat.cancelReply': '取消回复',
  'chat.loadingEarlier': '加载更早消息…',
  'chat.notifyAll': '通知此房间所有成员',
  'chat.everyone': '所有人',
  'chat.close': '关闭',

  'agents.title': '你的团队',
  'agents.of': '共 {n} 位',
  'agents.subtitle': '智能体可以独自工作，也可以彼此协作。需要你时会把你拉进来。',
  'agents.new': '新建智能体',
  'agents.working': '工作中',
  'agents.thinking': '思考中',
  'agents.available': '空闲',
  'agents.resting': '休息中',
  'agents.waiting': '等待你',
  'agents.chat': '聊天',
  'agents.whisper': '密语',
  'agents.opening': '打开中…',
  'agents.edit': '编辑',
  'agents.offboard': '下岗',
  'agents.tools': '工具',
  'agents.cancel': '取消',

  'onboarding.title': '设置你的电脑',
  'onboarding.body': '你的智能体运行在你自己的电脑（或 VPS）上，由本机的 Claude Code、Codex 或 Pi 驱动。之后每个智能体都可以选择自己的运行时和模型。',
  'onboarding.thisComputer': '这台电脑',
  'onboarding.noTerminal': 'Cumora 桌面会替你启动本机智能体宿主，不需要终端、Node 命令或配对命令。',
  'onboarding.connect': '连接这台电脑',
  'onboarding.reconnect': '重新连接这台电脑',
  'onboarding.connecting': '连接中…',
  'onboarding.checking': '正在检测本机运行时…',
  'onboarding.noRuntime': '未检测到受支持的运行时',
  'onboarding.installRuntime': '请在本机安装并登录 Claude Code、Codex 或 Pi，然后重新打开 Cumora 再试。',
  'onboarding.detected': '已检测到：{names}',
  'onboarding.starterRuntime': '起步团队运行时',
  'onboarding.running': '运行中',
  'onboarding.credentialsStay': 'Cumora 只使用本机已安装并登录的运行时；提供商凭据留在本地。',

  'auth.loading': '加载中…',
  'auth.starting': '正在启动本地服务…',
  'auth.startupError': '启动出错',
  'auth.welcome': '欢迎来到 Cumora',

  'docs.title': '文档',
  'docs.new': '新建文档',
  'cal.title': '日历',
  'cal.today': '今天',
  'cal.upcoming': '即将到来',
  'boards.title': '看板',
  'me.you': '我',
}

const en: Record<string, string> = {
  'rail.conversations': 'Conversations',
  'rail.whispers': 'Whispers',
  'rail.ship': 'Ship',
  'rail.boards': 'Boards',
  'rail.calendar': 'Calendar',
  'rail.docs': 'Docs',
  'rail.agents': 'Agents',
  'rail.me': 'Me',
  'rail.observe': 'Observe',
  'rail.signOut': 'Sign out',
  'rail.you': 'You',
  'agents.title': 'Your team',
  'agents.of': 'of {n}',
  'chat.send': 'Send',
  'chat.beginning': 'Beginning',
}

let current: Locale = 'zh-Hans'
try {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (saved === 'en' || saved === 'zh-Hans') current = saved
} catch { /* ignore */ }

export function getLocale(): Locale { return current }

export function setLocale(locale: Locale): void {
  current = locale
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* ignore */ }
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const table = current === 'en' ? en : zhHans
  let s = table[key] ?? en[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  }
  return s
}
