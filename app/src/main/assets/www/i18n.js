/**
 * Scholarius - 极简国际化。
 *
 * 默认语言为英文（DEFAULT_LOCALE），zh 词条已备好，可在个人页切换。
 * 支持两种绑定：data-i18n（文本）、data-i18n-aria-label。
 */
(function (global) {
    'use strict';

    var DEFAULT_LOCALE = 'en';
    var STORAGE_KEY = 'scholarius.locale';

    var MESSAGES = {
        en: {
            'app.name': 'Scholarius',
            'nav.label': 'Main Navigation',
            'nav.vault': 'Vault',
            'nav.explore': 'Explore',
            'nav.profile': 'Profile',

            // --- 文库页 ---
            'vault.searchPlaceholder': 'Search Title, Author, Venue',
            'vault.import': 'Import PDF',
            'vault.empty': 'No Documents Yet',
            'vault.emptyHint': 'Tap + To Import a PDF',
            'vault.noResult': 'Nothing Matches Your Search',
            'vault.pages': '{n} pages',
            'vault.deleteTitle': 'Delete?',
            'vault.deleteMessage': '{n} document(s) will be removed from this device. This cannot be undone.',
            'vault.deleteOneMessage': '"{title}" will be removed from this device. This cannot be undone.',
            'vault.importFailed': 'Could not import this file. Is it a valid PDF?',
            'vault.readerSoon': 'Reader coming soon',

            // --- 阅读页 ---
            'reader.loading': 'Extracting Text...',
            'reader.extractFailed': 'Could Not Extract Text From This PDF.',

            // 底部选项栏
            'reader.toc': 'Content',
            'reader.tocLabel': 'Content',
            'reader.settings': 'Reader Setting',
            'reader.settingsLabel': 'Setting',
            'reader.tocEmpty': 'No Headings Found In This Document.',
            'reader.abstract': 'Abstract',

            // 阅读设置：字体
            'reader.font': 'Font',
            'reader.fontSize': 'Font Size',
            'reader.fontSmaller': 'Decrease Font Size',
            'reader.fontLarger': 'Increase Font Size',
            'reader.fontColor': 'Font Colour',
            'reader.fontStyle': 'Font Family',
            'reader.color.strong': 'Strong',
            'reader.color.medium': 'Medium',
            'reader.color.soft': 'Soft',
            'reader.color.warm': 'Warm',
            'reader.font.serif': 'Serif',
            'reader.font.sans': 'Sans-serif',
            'reader.font.mono': 'Monospace',

            'selection.cancel': 'Cancel Selection',
            'selection.delete': 'Delete Selected',
            'selection.count': '{n} selected',

            'action.cancel': 'Cancel',
            'action.confirm': 'Confirm',
            'action.copy': 'Copy',
            'action.delete': 'Delete',
            'action.clear': 'Clear',
            'action.close': 'Close',

            // --- 登录页 ---
            'login.intro': 'Sign in with GitHub to Continue',
            'login.action': 'Sign in with GitHub',
            'login.openPage': 'Open authorization page',
            'login.codeHint': 'Enter This Code On GitHub:',
            'login.codeCopied': 'Code copied',
            'login.waiting': 'Waiting for authorization...',
            'login.leaveTitle': 'Open GitHub to authorize?',
            'login.leaveMessage': 'The browser will open GitHub. Enter this code there:\n\n{code}\n\nIt is already copied to your clipboard.',
            'login.leaveConfirm': 'Open browser',
            'login.leaveCancel': 'Stay here',
            'login.waitingFor': 'Waiting for authorization... {s}s',
            'login.error.network': 'Cannot reach GitHub. Check your network and try again.',
            'login.error.denied': 'Authorization was denied on GitHub.',
            'login.error.expired': 'The code expired. Please try again.',
            'login.error.invalid': 'GitHub rejected the request. The app may not have Device Flow enabled.',
            'login.error.unknown': 'Sign-in failed. Please try again.',

            // --- 个人页：账户 ---
            'account.loading': 'Loading...',
            'account.signOut': 'Sign Out',
            'account.signOutTitle': 'Sign Out Of Scholarius?',
            'account.signOutConfirm': 'The saved credentials will be removed from this device. Your reading data stays. You can revoke access any time on GitHub.',
            'account.signedOut': 'Signed out',
            'account.detailTitle': 'Account',
            'account.field.login': 'Username',
            'account.field.name': 'Display Name',
            'account.field.id': 'Account ID',
            'account.openOnGitHub': 'Open on GitHub',
            'action.back': 'Back',

            // --- 个人页：设置项 ---
            'setting.group.general': 'General',
            'setting.group.about': 'About',
            'setting.language': 'Language',
            'setting.language.en': 'English',
            'setting.language.zh': '中文',
            'setting.theme': 'Theme',
            'setting.theme.light': 'Light',
            'setting.theme.dark': 'Dark',
            'setting.theme.system': 'Follow System',
            'setting.version': 'Version',
            'setting.contact': 'Contact',
            'setting.debugLog': 'Logger',
            'setting.debugLog.on': 'On',
            'setting.debugLog.off': 'Off',
            'setting.debugLog.restartHint': 'Logger On',

            // --- 更新 ---
            'update.title': 'Update Available',
            'update.message': 'Version {version} has been released ({size}). You are on {current}.',
            'update.later': 'Later',
            'update.now': 'Update',
            'update.downloading': 'Downloading...',
            'update.retryInstall': 'Retry install',
            'update.installing': 'Downloaded, installing...',
            'update.upToDate': 'You are on the latest version',
            'update.checking': 'Checking for updates...',
            'update.failed.permission': 'Allow Scholarius to install apps in the system settings, then come back and retry.',
            'update.failed.network': 'Download failed. Check your network and try again.',
            'update.failed.install': 'Could not start the installer. Please install the APK manually.',
            'update.failed.invalid': 'The downloaded file is not a valid APK. Please try again.',
            'update.failed.truncated': 'The download was incomplete. Please try again.',
            'update.failed.mismatch': 'The downloaded package does not match the released version. Please try again.',
            'update.failed.downgrade': 'The downloaded package is not newer than the installed one, so it was not installed.',
            'update.failed.unknown': 'Update failed. Please try again later.',
            'update.stalled': 'The previous install did not take effect. Allow Scholarius to install apps in the system settings, then try again.'
        },
        zh: {
            'app.name': 'Scholarius',
            'nav.label': '主导航',
            'nav.vault': '文库',
            'nav.explore': '探索',
            'nav.profile': '个人',

            // --- 文库页 ---
            'vault.searchPlaceholder': '搜索标题、作者、发表物',
            'vault.import': '导入 PDF',
            'vault.empty': '还没有文献',
            'vault.emptyHint': '点右上角 + 导入 PDF',
            'vault.noResult': '没有匹配的文献',
            'vault.pages': '{n} 页',
            'vault.deleteTitle': '删除？',
            'vault.deleteMessage': '将从本机移除 {n} 篇文献，此操作不可撤销。',
            'vault.deleteOneMessage': '将从本机移除《{title}》，此操作不可撤销。',
            'vault.importFailed': '无法导入该文件，请确认是有效的 PDF。',
            'vault.readerSoon': '阅读页即将推出',

            // --- 阅读页 ---
            'reader.loading': '正在提取文本…',
            'reader.extractFailed': '无法从这份 PDF 提取文本。',

            // 底部选项栏
            'reader.toc': '目录',
            'reader.tocLabel': '目录',
            'reader.settings': '阅读设置',
            'reader.settingsLabel': '设置',
            'reader.tocEmpty': '未能从本文中识别出标题。',
            'reader.abstract': '摘要',

            // 阅读设置：字体
            'reader.font': '字体',
            'reader.fontSize': '字号',
            'reader.fontSmaller': '减小字号',
            'reader.fontLarger': '增大字号',
            'reader.fontColor': '字体颜色',
            'reader.fontStyle': '字体样式',
            'reader.color.strong': '强对比',
            'reader.color.medium': '中对比',
            'reader.color.soft': '弱对比',
            'reader.color.warm': '暖色',
            'reader.font.serif': '衬线',
            'reader.font.sans': '无衬线',
            'reader.font.mono': '等宽',

            'selection.cancel': '取消选择',
            'selection.delete': '删除所选',
            'selection.count': '已选 {n} 项',

            'action.cancel': '取消',
            'action.confirm': '确定',
            'action.copy': '复制',
            'action.delete': '删除',
            'action.clear': '清空',
            'action.close': '关闭',

            'login.intro': '用 GitHub 登录以继续',
            'login.action': '用 GitHub 登录',
            'login.openPage': '打开授权页',
            'login.codeHint': '在 GitHub 上输入这个码：',
            'login.codeCopied': '已复制设备码',
            'login.waiting': '正在等待授权…',
            'login.leaveTitle': '用浏览器打开 GitHub 授权？',
            'login.leaveMessage': '浏览器会打开 GitHub。到那边请输入这串码：\n\n{code}\n\n它已复制到剪贴板，粘贴即可。',
            'login.leaveConfirm': '打开浏览器',
            'login.leaveCancel': '留在这里',
            'login.waitingFor': '正在等待授权… {s} 秒',
            'login.error.network': '连不上 GitHub，请检查网络后重试。',
            'login.error.denied': '你在 GitHub 上拒绝了这次授权。',
            'login.error.expired': '设备码已过期，请重新登录。',
            'login.error.invalid': 'GitHub 拒绝了请求，可能是 OAuth App 没有启用 Device Flow。',
            'login.error.unknown': '登录失败，请重试。',

            'account.loading': '加载中…',
            'account.signOut': '退出登录',
            'account.signOutTitle': '确定退出登录？',
            'account.signOutConfirm': '本设备上保存的凭据会被删除，阅读数据保留。随时可以在 GitHub 上撤销授权。',
            'account.signedOut': '已退出登录',
            'account.detailTitle': '账户',
            'account.field.login': '用户名',
            'account.field.name': '显示名',
            'account.field.id': '账号 ID',
            'account.openOnGitHub': '在 GitHub 中打开',
            'action.back': '返回',

            'setting.group.general': '通用',
            'setting.group.about': '关于',
            'setting.language': '语言',
            'setting.language.en': 'English',
            'setting.language.zh': '中文',
            'setting.theme': '主题',
            'setting.theme.light': '日间模式',
            'setting.theme.dark': '夜间模式',
            'setting.theme.system': '跟随系统',
            'setting.version': '版本',
            'setting.contact': '联系',
            'setting.debugLog': 'Logger',
            'setting.debugLog.on': '开',
            'setting.debugLog.off': '关',
            'setting.debugLog.restartHint': 'Logger 已开启',

            'update.title': '发现新版本',
            'update.message': '新版本 {version} 已发布（{size}），当前版本 {current}。',
            'update.later': '稍后',
            'update.now': '更新',
            'update.downloading': '正在下载…',
            'update.retryInstall': '重试安装',
            'update.installing': '下载完成，正在安装…',
            'update.upToDate': '已是最新版本',
            'update.checking': '正在检查更新…',
            'update.failed.permission': '请在系统设置里允许 Scholarius 安装应用，然后回到这里重试。',
            'update.failed.network': '下载失败，请检查网络后重试。',
            'update.failed.install': '无法拉起安装器，请手动安装下载好的 APK。',
            'update.failed.invalid': '下载到的不是合法的安装包，请重试。',
            'update.failed.truncated': '下载不完整，请重试。',
            'update.failed.mismatch': '下载到的包与发布版本不一致，请重试。',
            'update.failed.downgrade': '下载到的包不比已安装的版本新，已阻止安装。',
            'update.failed.unknown': '更新失败，请稍后再试。',
            'update.stalled': '上一次安装没有生效。请确认系统已允许 Scholarius 安装应用，然后重试。'
        }
    };

    var currentLocale = DEFAULT_LOCALE;
    var listeners = [];

    function normalize(locale) {
        if (!locale) return DEFAULT_LOCALE;
        return String(locale).toLowerCase().indexOf('zh') === 0 ? 'zh' : DEFAULT_LOCALE;
    }

    function t(key) {
        var table = MESSAGES[currentLocale] || MESSAGES[DEFAULT_LOCALE];
        if (Object.prototype.hasOwnProperty.call(table, key)) {
            return table[key];
        }
        var fallback = MESSAGES[DEFAULT_LOCALE];
        return Object.prototype.hasOwnProperty.call(fallback, key) ? fallback[key] : key;
    }

    function getLocale() {
        return currentLocale;
    }

    /** 把当前语言写进所有带 data-i18n* 属性的元素 */
    function apply(root) {
        var scope = root || document;

        var nodes = scope.querySelectorAll('[data-i18n]');
        for (var i = 0; i < nodes.length; i++) {
            nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
        }

        var ariaNodes = scope.querySelectorAll('[data-i18n-aria-label]');
        for (var j = 0; j < ariaNodes.length; j++) {
            ariaNodes[j].setAttribute(
                'aria-label', t(ariaNodes[j].getAttribute('data-i18n-aria-label'))
            );
        }
    }

    function setLocale(locale) {
        var next = normalize(locale);
        if (next === currentLocale) return;
        currentLocale = next;
        try {
            localStorage.setItem(STORAGE_KEY, currentLocale);
        } catch (e) { /* 忽略 */ }
        apply();
        listeners.forEach(function (fn) {
            try {
                fn(currentLocale);
            } catch (e) { /* 单个订阅者出错不影响其它 */ }
        });
    }

    function onChange(fn) {
        if (typeof fn === 'function') listeners.push(fn);
    }

    function readStoredLocale() {
        try {
            return normalize(localStorage.getItem(STORAGE_KEY));
        } catch (e) {
            return DEFAULT_LOCALE;
        }
    }

    /** 默认英文；只有显式切到中文时才用 zh，不跟随系统语言 */
    currentLocale = readStoredLocale();

    global.ScholariusI18n = {
        t: t,
        apply: apply,
        getLocale: getLocale,
        setLocale: setLocale,
        onChange: onChange,
        DEFAULT_LOCALE: DEFAULT_LOCALE
    };
})(window);
