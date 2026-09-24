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
            'vault.pages': '{n} Pages',
            /*
              详情页只读区专用。
              ⚠️ 不能复用 vault.pages —— 那个是卡片上的简短形式
                 （卡片宽度有限，塞不下「File Pages 10 Pages」）。
                 而详情页要与「Page Range」（起止页码）区分开，
                 必须把「文件」这个限定词写出来。
            */
            'detail.filePages': 'File Pages',
            'vault.deleteTitle': 'Delete?',
            'vault.deleteMessage': '{n} document(s) will be removed from this device. This cannot be undone.',
            'vault.deleteOneMessage': '"{title}" will be removed from this device. This cannot be undone.',
            'vault.importFailed': 'Could not import this file. Is it a valid PDF?',
            'vault.readerSoon': 'Reader Coming Soon',

            /*
              文献类型（发表载体性质）。

              ⚠️ 这些文案是**给卡片上的类型标签**用的，会出现在
                 发表物那一行的左侧，所以必须短 —— 太长会挤压右侧的载体名。
                 实测卡片可用宽度约 336px，左侧图标 + 文字要控制在 60px 内。

              ⚠️ unknown 类型**不显示文字**（只留空位），
                 理由见 vault.js 里 VENUE_TYPE 的说明：
                 猜错的代价比不显示更大。
            */
            'venue.type.conference': 'Conference',
            'venue.type.journal': 'Journal',
            'venue.type.preprint': 'Preprint',
            'venue.type.book': 'Book',
            'venue.type.thesis': 'Thesis',
            'venue.type.report': 'Report',
            'venue.type.unknown': 'Not Set',

            /*
              ── 文献详情（编辑元数据）──

              ⚠️ 这些标签会出现在**弹窗表单的左侧**，宽度约 40%。
                 措辞要短，且必须能自解释（没有说明文字的位置）。
            */
            'meta.title': 'Document Details',
            'meta.close': 'Close',
            'meta.save': 'Save',
            'meta.saved': 'Saved',
            'meta.typeLabel': 'Type',
            'meta.typeHint': 'Pick a type first — the fields below change with it.',
            'meta.placeholder': 'Not Set',
            'reader.details': 'Details',
            'detail.sourceFile': 'Source File',
            'detail.saveFailed': 'Could Not Save Changes.',

            // 通用字段
            'vault.field.title': 'Title',
            'vault.field.author': 'Author',
            'vault.field.year': 'Year',
            'vault.field.date': 'Date',
            'detail.datePart.year': 'Year',
            'detail.datePart.month': 'Month',
            'detail.datePart.day': 'Day',
            // ⚠️ 这是**短标题**：填了之后会**顶替卡片①行的标题**
            //    （见 vault.js renderCard）。
            //    它不是**发表物简称**（会议/期刊的缩写，那个在
            //    「设置 → 发表物简称」里配，作用在卡片③行）。
            //
            // ⚠️ 英文用 `Short Title` 而不是 `Document Short Name`：
            //    · `shorttitle` 是 BibTeX / Zotero 的标准字段名，
            //      做文献管理的人一看就懂；
            //    · ISO 4 专门规定「标题缩写」的规则，
            //      这个词有领域惯例支撑，不是自造词；
            //    · 它天然表达了「是标题的短形式」——
            //      正好对上「顶替标题显示」这个行为。
            'vault.field.shortTitle': 'Short Title',
            'vault.hint.shortTitle': 'Shown instead of title',

            // 期刊
            'vault.field.journalName': 'Journal',
            'vault.field.volume': 'Volume',
            'vault.field.issue': 'Issue',
            'vault.field.pageStart': 'Start Page',
            'vault.field.pageEnd': 'End Page',
            'vault.field.doi': 'DOI',
            'vault.field.doiRegistrant': 'DOI Registrant',
            'vault.field.doiSuffix': 'DOI Suffix',

            // 占位提示（用户要求：所有空的输入框都给填充提示）
            'vault.hint.author': 'e.g. LeCun, Bengio, Hinton',
            'vault.hint.venueName': 'e.g. Nature',
            'vault.hint.volume': 'e.g. 521',
            'vault.hint.issue': 'e.g. 7553',
            'vault.hint.pageStart': 'e.g. 436',
            'vault.hint.pageEnd': 'e.g. 444',
            'vault.hint.conferenceName': 'e.g. Neural Information Processing Systems',
            'vault.hint.abbrev': 'e.g. NIPS',
            'vault.hint.place': 'e.g. Montreal, Canada',
            'vault.hint.server': 'e.g. arXiv',
            'vault.hint.preprintId': 'e.g. arXiv:1508.01234',
            'vault.hint.publisher': 'e.g. MIT Press',
            'vault.hint.isbn': 'e.g. 978-0-262-03561-3',
            'vault.hint.edition': 'e.g. 2nd',
            'vault.hint.institution': 'e.g. University of Toronto',
            'vault.hint.reportNumber': 'e.g. TR-2015-01',

            // 会议
            'vault.field.conferenceName': 'Conference',
            'vault.field.conferenceShort': 'Abbreviation',
            'vault.field.conferencePlace': 'Place',

            // 预印本
            'vault.field.preprintServer': 'Server',
            'vault.field.preprintId': 'Identifier',

            // 专著
            'vault.field.publisher': 'Publisher',
            'vault.field.isbn': 'ISBN',
            'vault.field.edition': 'Edition',

            // 学位论文 / 报告（共用 institution）
            'vault.field.institution': 'Institution',
            'vault.field.thesisType': 'Degree',
            'vault.field.reportNumber': 'Report No.',

            // 学位类型选项
            'thesis.phd': 'PhD',
            'thesis.master': "Master's",
            'thesis.bachelor': "Bachelor's",
            'thesis.other': 'Other',

            /*
              ── 设置：发表物简称 ──

              用户可以把「会议/期刊的全名」映射到一个短名，
              卡片上就显示短名（NIPS 而不是 Neural Information Processing Systems）。
            */
            'setting.group.vault': 'Vault',
            'setting.venueShortcut': 'Venue Abbreviations',
            'shortcut.title': 'Venue Abbreviations',
            'shortcut.empty': 'No Abbreviations Yet.',
            'shortcut.emptyHint': 'Add one to shorten long venue names on cards.',
            'shortcut.add': 'Add',
            'shortcut.fullLabel': 'Full Name',
            'shortcut.shortLabel': 'Abbreviation',
            'shortcut.fullPlaceholder': 'e.g. Neural Information Processing Systems',
            'shortcut.shortPlaceholder': 'e.g. NIPS',
            'shortcut.delete': 'Delete',
            'shortcut.count': '{n} Saved',
            'shortcut.needBoth': 'Both fields are required.',
            'shortcut.duplicate': 'That Full Name Already Exists.',

            // --- 阅读页 ---
            'reader.loading': 'Extracting Text...',
            'reader.extractFailed': 'Could Not Extract Text From This PDF.',
            'reader.noBridge': 'Reader Is Unavailable In This Preview.',

            // 底部选项栏
            'reader.toc': 'Content',
            'reader.tocLabel': 'Content',
            'reader.settings': 'Reader Setting',
            'reader.settingsLabel': 'Setting',
            'reader.tocEmpty': 'No Headings Found In This Document.',
            'reader.abstract': 'Abstract',

            /*
              视图切换按钮的**无障碍标签**。

              ⚠️ 写的是「点了会切到哪个视图」，不是「当前是哪个视图」——
                 按钮标签应该描述**动作的后果**。
                 当前状态由 aria-pressed 表达，不靠 label 重复。

              ⚠️ 术语（用户 2026-09-24 定）：
                 reading = 重排后的正文，用来**读**；
                 raw     = 出版方原始版面，用来**核对**。
                 英文不用 "PDF View" —— 那是文件格式，不是用户的意图。
            */
            'reader.rawView': 'Raw View',
            'reader.readingView': 'Reading View',
            'reader.pageUnavailable': 'Page Unavailable.',

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
            'selection.count': '{n} Selected',

            'action.cancel': 'Cancel',
            'action.confirm': 'Confirm',
            'action.copy': 'Copy',
            'action.delete': 'Delete',
            'action.clear': 'Clear',
            'action.close': 'Close',

            // --- 登录页 ---
            'login.intro': 'Sign in with GitHub to Continue',
            'login.action': 'Sign in with GitHub',
            'login.openPage': 'Open Authorization Page',
            'login.codeHint': 'Enter This Code On GitHub:',
            'login.codeCopied': 'Code Copied',
            'login.waiting': 'Waiting for authorization...',
            'login.leaveTitle': 'Open GitHub to authorize?',
            'login.leaveMessage': 'The browser will open GitHub. Enter this code there:\n\n{code}\n\nIt is already copied to your clipboard.',
            'login.leaveConfirm': 'Open Browser',
            'login.leaveCancel': 'Stay Here',
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
            'account.signedOut': 'Signed Out',
            'account.detailTitle': 'Account',
            'account.field.login': 'Username',
            'account.field.name': 'Display Name',
            'account.field.id': 'Account ID',
            'account.openOnGitHub': 'Open On GitHub',
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
            /*
              ⚠️ 必须**一行放得下**（用户 2026-09-24：「尽量做到一行文字解决」）。

                 旧文案是两句：
                     'Version {version} has been released ({size}). You are on {current}.'
                 实测 360dp 屏（正文框 320px）下**换行成两行**。

                 取舍：
                 · 「has been released」是废话 —— 标题已写 Update Available；
                 · 「You are on {current}」可以去掉 —— 当前版本在
                   设置 → Version 里就能看到，不必占一句；
                 · size 保留，用户想知道要下载多少流量。

                 ⚠️ 中文同样控制在一行内（中文更短，好办）。

                 ⚠️ 改文案时**必须回 360dp 宽度实测**行数，
                    预览用的宽窗口（459px）下一行也是装得下的，
                    看不出问题。
            */
            'update.message': 'Version {version} ({size}) is ready.',
            'update.later': 'Later',
            'update.now': 'Update',
            'update.downloading': 'Downloading...',
            'update.retryInstall': 'Retry Install',
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
            'detail.filePages': '文件页数',
            'vault.deleteTitle': '删除？',
            'vault.deleteMessage': '将从本机移除 {n} 篇文献，此操作不可撤销。',
            'vault.deleteOneMessage': '将从本机移除《{title}》，此操作不可撤销。',
            'vault.importFailed': '无法导入该文件，请确认是有效的 PDF。',
            'vault.readerSoon': '阅读页即将推出',

            /*
              文献类型（发表载体性质）。

              ⚠️ 中文里「会议」「期刊」这类词只有 2 个字，
                 比英文的 Conference/Journal 窄得多，
                 卡片左侧的图标位宽度要按**较宽的那一种**预留。
            */
            'venue.type.conference': '会议',
            'venue.type.journal': '期刊',
            'venue.type.preprint': '预印本',
            'venue.type.book': '专著',
            'venue.type.thesis': '学位论文',
            'venue.type.report': '报告',
            'venue.type.unknown': '未设定',

            /*
              ── 文献详情（编辑元数据）──

              ⚠️ 中文标签比英文短，但「学位论文」「预印本平台」这类
                 仍是 4~5 字，表单一列放得下。
            */
            'meta.title': '文献详情',
            'meta.close': '关闭',
            'meta.save': '保存',
            'meta.saved': '已保存',
            'meta.typeLabel': '类别',
            'meta.typeHint': '先选类别，下面的字段会跟着变。',
            'meta.placeholder': '未填',
            'reader.details': '详情',
            'detail.sourceFile': '源文件',
            'detail.saveFailed': '无法保存修改。',

            // 通用字段
            'vault.field.title': '标题',
            'vault.field.author': '作者',
            'vault.field.year': '年份',
            'vault.field.date': '日期',
            'detail.datePart.year': '年',
            'detail.datePart.month': '月',
            'detail.datePart.day': '日',
            // ⚠️ 这是**短标题**：填了之后会**顶替卡片①行的标题**
            //    （见 vault.js renderCard）。
            //    它不是**发表物简称**（会议/期刊的缩写，那个在
            //    「设置 → 发表物简称」里配，作用在卡片③行）。
            //
            // ⚠️ 中英**故意不逐字对应**：英文走 `Short Title`
            //    （BibTeX / Zotero 的 shorttitle，领域惯例），
            //    中文用「短标题」—— 比「标题缩写」顺，也同长度。
            'vault.field.shortTitle': '短标题',
            'vault.hint.shortTitle': '填入后顶替卡片标题',

            // 期刊
            'vault.field.journalName': '期刊',
            'vault.field.volume': '卷',
            'vault.field.issue': '期',
            'vault.field.pageStart': '起始页',
            'vault.field.pageEnd': '终止页',
            'vault.field.doi': 'DOI',
            'vault.field.doiRegistrant': 'DOI 注册机构号',
            'vault.field.doiSuffix': 'DOI 后缀',

            // 占位提示
            'vault.hint.author': '如 杨振宁、李政道',
            'vault.hint.venueName': '如 《物理学报》',
            'vault.hint.volume': '如 521',
            'vault.hint.issue': '如 7553',
            'vault.hint.pageStart': '如 436',
            'vault.hint.pageEnd': '如 444',
            'vault.hint.conferenceName': '如 神经网络信息处理大会',
            'vault.hint.abbrev': '如 NIPS',
            'vault.hint.place': '如 加拿大蒙特利尔',
            'vault.hint.server': '如 arXiv',
            'vault.hint.preprintId': '如 arXiv:1508.01234',
            'vault.hint.publisher': '如 人民邮电出版社',
            'vault.hint.isbn': '如 978-7-115-39581-6',
            'vault.hint.edition': '如 第 2 版',
            'vault.hint.institution': '如 清华大学',
            'vault.hint.reportNumber': '如 TR-2015-01',

            // 会议
            'vault.field.conferenceName': '会议',
            'vault.field.conferenceShort': '简称',
            'vault.field.conferencePlace': '地点',

            // 预印本
            'vault.field.preprintServer': '平台',
            'vault.field.preprintId': '编号',

            // 专著
            'vault.field.publisher': '出版社',
            'vault.field.isbn': 'ISBN',
            'vault.field.edition': '版次',

            // 学位论文 / 报告
            'vault.field.institution': '机构',
            'vault.field.thesisType': '学位',
            'vault.field.reportNumber': '报告编号',

            // 学位类型选项
            'thesis.phd': '博士',
            'thesis.master': '硕士',
            'thesis.bachelor': '学士',
            'thesis.other': '其他',

            /*
              ── 设置：发表物简称 ──
            */
            'setting.group.vault': '文库',
            'setting.venueShortcut': '发表物简称',
            'shortcut.title': '发表物简称',
            'shortcut.empty': '还没有添加简称。',
            'shortcut.emptyHint': '添加后，卡片上会显示短名而不是一长串全名。',
            'shortcut.add': '添加',
            'shortcut.fullLabel': '全名',
            'shortcut.shortLabel': '简称',
            'shortcut.fullPlaceholder': '如 Neural Information Processing Systems',
            'shortcut.shortPlaceholder': '如 NIPS',
            'shortcut.delete': '删除',
            'shortcut.count': '已保存 {n} 条',
            'shortcut.needBoth': '两项都要填写。',
            'shortcut.duplicate': '这个全名已经存在。',

            // --- 阅读页 ---
            'reader.loading': '正在提取文本…',
            'reader.extractFailed': '无法从这份 PDF 提取文本。',
            'reader.noBridge': '预览环境不支持阅读页。',

            // 底部选项栏
            'reader.toc': '目录',
            'reader.tocLabel': '目录',
            'reader.settings': '阅读设置',
            'reader.settingsLabel': '设置',
            'reader.tocEmpty': '未能从本文中识别出标题。',
            'reader.abstract': '摘要',

            // 视图切换（无参标签，写「点了会切到哪个视图」）
            'reader.rawView': '原始视图',
            'reader.readingView': '阅读视图',
            'reader.pageUnavailable': '无法显示该页。',


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
            // 一行放得下（见英文侧同一条的长注释）
            'update.message': '新版本 {version}（{size}）已就绪。',
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
