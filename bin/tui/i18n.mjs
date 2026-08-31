// Localization for the OpenHark TUI. Keyed by the English string itself, so an unwrapped or
// untranslated string degrades to English rather than a missing-key marker. Five locales:
// en, fr, es, zh, and mx ("matrix"), a width-preserving cipher into halfwidth katakana.
//
// Width matters here: the jobs listtable auto-sizes on blessed's strWidth (CJK = 2 cells,
// halfwidth katakana = 1), so Chinese aligns and the matrix cipher never shifts a column.
// The few MANUALLY padded areas must use padW/padEndW (below), which count display cells.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../env.mjs';

export const LOCALES = ['en', 'fr', 'es', 'zh', 'mx'];
export const LOCALE_NAMES = { en: 'English', fr: 'Français', es: 'Español', zh: '中文', mx: 'マトリックス' };

// The matrix cipher: A-Z / a-z -> halfwidth katakana (U+FF66..U+FF9D, one cell each), case kept
// distinct by an offset. Digits and punctuation pass through, as they do in the film's rain, so
// numbers and structure stay legible. Deterministic, so a given word always ciphers the same way.
const KANA0 = 0xff66, KANA_SPAN = 0x38; // 56 halfwidth katakana code points
const cipherChar = (c) => {
	const k = c.charCodeAt(0);
	if (k >= 65 && k <= 90) return String.fromCharCode(KANA0 + ((k - 65) % KANA_SPAN));
	if (k >= 97 && k <= 122) return String.fromCharCode(KANA0 + ((k - 97 + 26) % KANA_SPAN));
	return c;
};
const matrixize = (s) => String(s).replace(/[A-Za-z]/g, cipherChar);

// Display width in terminal cells: CJK (and other East Asian wide ranges) are 2, everything else 1.
// Blessed strips tags before measuring; these strings are plain (t runs before color wrapping), so a
// simple range test suffices without pulling in blessed here.
const isWide = (cp) =>
	(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
	(cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi
	(cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, full Katakana, CJK symbols (NOT halfwidth FF66+)
	(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
	(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
	(cp >= 0xa000 && cp <= 0xa4cf) || // Yi
	(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
	(cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
	(cp >= 0xff01 && cp <= 0xff60) || // fullwidth forms
	(cp >= 0xffe0 && cp <= 0xffe6); // fullwidth signs
export const dispWidth = (s) => {
	let w = 0;
	for (const ch of String(s)) w += isWide(ch.codePointAt(0)) ? 2 : 1;
	return w;
};
// Pad to n DISPLAY cells (not code units), so a CJK or accented label lines up in a fixed column.
export const padEndW = (s, n) => { const pad = n - dispWidth(s); return pad > 0 ? s + ' '.repeat(pad) : s; };

// Translations. Keys are the exact English source strings. Uppercase entries keep case per locale
// (Chinese has none). Missing keys fall back to English; the matrix locale ignores this table.
const DICT = {
	// --- pipeline stage labels (STATUS column + timeline) ---
	QUEUED: { fr: 'EN FILE', es: 'EN COLA', zh: '排队' },
	WORKTREE: { fr: 'ARBRE', es: 'ÁRBOL', zh: '工作区' },
	EDITING: { fr: 'ÉDITION', es: 'EDICIÓN', zh: '编辑中' },
	COMMIT: { fr: 'COMMIT', es: 'COMMIT', zh: '提交' },
	TESTS: { fr: 'TESTS', es: 'PRUEBAS', zh: '测试' },
	FIXING: { fr: 'CORRECT.', es: 'ARREGLO', zh: '修复中' },
	'PR OPEN': { fr: 'PR OUVERT', es: 'PR ABIERTA', zh: 'PR开启' },
	REVIEW: { fr: 'REVUE', es: 'REVISIÓN', zh: '审查' },
	APPROVED: { fr: 'APPROUVÉ', es: 'APROBADO', zh: '已批准' },
	MERGING: { fr: 'FUSION', es: 'FUSIÓN', zh: '合并中' },
	MERGED: { fr: 'FUSIONNÉ', es: 'FUSIONADO', zh: '已合并' },
	CHANGES: { fr: 'CHANGEM.', es: 'CAMBIOS', zh: '需修改' },
	FAILED: { fr: 'ÉCHOUÉ', es: 'FALLÓ', zh: '失败' },
	SKIPPED: { fr: 'IGNORÉ', es: 'OMITIDO', zh: '跳过' },
	FLAKY: { fr: 'INSTABLE', es: 'INESTABLE', zh: '不稳定' },
	DONE: { fr: 'FAIT', es: 'HECHO', zh: '完成' },
	DISPUTED: { fr: 'CONTESTÉ', es: 'DISPUTADO', zh: '有争议' },
	START: { fr: 'DÉBUT', es: 'INICIO', zh: '开始' },
	// --- jobs column headers ---
	ID: { fr: 'ID', es: 'ID', zh: '编号' },
	TICKET: { fr: 'TICKET', es: 'TICKET', zh: '工单' },
	AGENTS: { fr: 'AGENTS', es: 'AGENTES', zh: '智能体' },
	STATUS: { fr: 'STATUT', es: 'ESTADO', zh: '状态' },
	REV: { fr: 'RÉV', es: 'REV', zh: '版本' },
	COM: { fr: 'COM', es: 'COM', zh: '评论' },
	END: { fr: 'FIN', es: 'FIN', zh: '结束' },
	TIME: { fr: 'TEMPS', es: 'TIEMPO', zh: '时长' },
	// --- group separators (lowercase) ---
	running: { fr: 'en cours', es: 'en curso', zh: '运行中' },
	active: { fr: 'actif', es: 'activo', zh: '活跃' },
	done: { fr: 'terminé', es: 'hecho', zh: '完成' },
	// --- detail-pane section headers ---
	'SWARM RUNNERS': { fr: 'EXÉCUTEURS', es: 'EJECUTORES', zh: '集群执行器' },
	'OPENHARK COPILOT': { fr: 'COPILOTE OPENHARK', es: 'COPILOTO OPENHARK', zh: 'OPENHARK 副驾' },
	'WHY SKIPPED': { fr: 'POURQUOI IGNORÉ', es: 'POR QUÉ OMITIDO', zh: '为何跳过' },
	'WHY FAILED': { fr: 'POURQUOI ÉCHEC', es: 'POR QUÉ FALLÓ', zh: '为何失败' },
	'REVIEW FLAKY': { fr: 'REVUE INSTABLE', es: 'REVISIÓN INESTABLE', zh: '审查不稳定' },
	'ALREADY DONE': { fr: 'DÉJÀ FAIT', es: 'YA HECHO', zh: '已完成' },
	'PREMISE DISPUTED': { fr: 'PRÉMISSE CONTESTÉE', es: 'PREMISA DISPUTADA', zh: '前提有争议' },
	'CHANGES REQUESTED': { fr: 'CHANGEMENTS DEMANDÉS', es: 'CAMBIOS SOLICITADOS', zh: '请求修改' },
	PROMPT: { fr: 'INVITE', es: 'INSTRUCCIÓN', zh: '提示词' },
	SCOPE: { fr: 'PORTÉE', es: 'ALCANCE', zh: '范围' },
	STAGES: { fr: 'ÉTAPES', es: 'ETAPAS', zh: '阶段' },
	TIMELINE: { fr: 'CHRONOLOGIE', es: 'CRONOLOGÍA', zh: '时间线' },
	'AGENT LOG': { fr: 'JOURNAL AGENT', es: 'REGISTRO AGENTE', zh: '智能体日志' },
	// --- panel titles ---
	JOBS: { fr: 'TÂCHES', es: 'TRABAJOS', zh: '任务' },
	RUNS: { fr: 'EXÉCUTIONS', es: 'EJECUCIONES', zh: '运行' },
	DETAIL: { fr: 'DÉTAIL', es: 'DETALLE', zh: '详情' },
	// --- tab names (lowercase) ---
	jobs: { fr: 'tâches', es: 'trabajos', zh: '任务' },
	backlog: { fr: 'backlog', es: 'backlog', zh: '待办' },
	agent: { fr: 'agent', es: 'agente', zh: '智能体' },
	prompt: { fr: 'invite', es: 'instrucción', zh: '提示' },
	scope: { fr: 'portée', es: 'alcance', zh: '范围' },
	stages: { fr: 'étapes', es: 'etapas', zh: '阶段' },
	timeline: { fr: 'chrono', es: 'crono', zh: '时间线' },
	log: { fr: 'journal', es: 'registro', zh: '日志' },
	'(click or t)': { fr: '(cliquez ou t)', es: '(clic o t)', zh: '(点击或 t)' },
	// --- STAGES progress list (detail pane) ---
	queue: { fr: 'file', es: 'cola', zh: '排队' },
	develop: { fr: 'développer', es: 'desarrollar', zh: '开发' },
	test: { fr: 'tester', es: 'probar', zh: '测试' },
	'blocking review': { fr: 'revue bloquante', es: 'revisión bloqueante', zh: '阻塞审查' },
	'(no events yet)': { fr: '(aucun événement)', es: '(sin eventos)', zh: '(暂无事件)' },
	// --- runs table headers ---
	RUN: { fr: 'EXÉC', es: 'EJEC', zh: '运行' },
	STARTED: { fr: 'DÉBUT', es: 'INICIO', zh: '开始' },
	TKT: { fr: 'TKT', es: 'TKT', zh: '工单' },
	MRG: { fr: 'FUS', es: 'FUS', zh: '合并' },
	FAIL: { fr: 'ÉCH', es: 'FALLO', zh: '失败' },
	complete: { fr: 'terminé', es: 'completo', zh: '完成' },
	// --- hint words (help bar) ---
	tab: { fr: 'onglet', es: 'pestaña', zh: '标签' },
	pick: { fr: 'choisir', es: 'elegir', zh: '选择' },
	launch: { fr: 'lancer', es: 'lanzar', zh: '启动' },
	auto: { fr: 'auto', es: 'auto', zh: '自动' },
	merge: { fr: 'fusion', es: 'fusionar', zh: '合并' },
	retry: { fr: 'réessayer', es: 'reintentar', zh: '重试' },
	kill: { fr: 'tuer', es: 'matar', zh: '终止' },
	connect: { fr: 'connecter', es: 'conectar', zh: '连接' },
	tracker: { fr: 'suivi', es: 'rastreador', zh: '追踪器' },
	settings: { fr: 'réglages', es: 'ajustes', zh: '设置' },
	quit: { fr: 'quitter', es: 'salir', zh: '退出' },
	lang: { fr: 'langue', es: 'idioma', zh: '语言' },
	language: { fr: 'langue', es: 'idioma', zh: '语言' },
	'up/down sel': { fr: 'haut/bas sél', es: 'arr/aba sel', zh: '上/下 选' },
	'sort 1-9 (0 clear)': { fr: 'tri 1-9 (0 efface)', es: 'orden 1-9 (0 limpia)', zh: '排序 1-9 (0 清除)' },
	// --- empty / loading states ---
	'no jobs yet': { fr: 'aucune tâche', es: 'sin trabajos', zh: '暂无任务' },
	'no runs yet': { fr: 'aucune exécution', es: 'sin ejecuciones', zh: '暂无运行' },
	'press b to reload, or the backlog is empty': { fr: 'appuyez sur b pour recharger, ou le backlog est vide', es: 'pulse b para recargar, o el backlog está vacío', zh: '按 b 重新加载，或待办为空' },
	'listing open tickets from the tracker...': { fr: 'liste des tickets ouverts du suivi...', es: 'listando tickets abiertos del rastreador...', zh: '正在列出追踪器的待办工单...' },
	'loading ticket detail...': { fr: 'chargement du détail...', es: 'cargando detalle...', zh: '加载工单详情...' },
	'(loading)': { fr: '(chargement)', es: '(cargando)', zh: '(加载中)' },
	self: { fr: 'soi', es: 'propio', zh: '自身' },
	// --- toasts / status line ---
	'sort: newest run first': { fr: 'tri : exécution la plus récente', es: 'orden: ejecución más reciente', zh: '排序：最新运行优先' },
	sort: { fr: 'tri', es: 'orden', zh: '排序' },
	'prompt saved': { fr: 'invite enregistrée', es: 'instrucción guardada', zh: '提示词已保存' },
	'keep at least one runner': { fr: 'gardez au moins un exécuteur', es: 'mantenga al menos un ejecutor', zh: '至少保留一个执行器' },
	'no harnesses available': { fr: 'aucun harnais disponible', es: 'sin harness disponibles', zh: '无可用框架' },
	'no models discovered for': { fr: 'aucun modèle trouvé pour', es: 'sin modelos para', zh: '未发现模型：' },
	'fable picking disjoint...': { fr: 'fable choisit des disjoints...', es: 'fable eligiendo disjuntos...', zh: 'fable 正在挑选不重叠项...' },
	checked: { fr: 'coché', es: 'marcados', zh: '已选' },
	disjoint: { fr: 'disjoints', es: 'disjuntos', zh: '个不重叠项' },
	'tracker connected': { fr: 'suivi connecté', es: 'rastreador conectado', zh: '追踪器已连接' },
	days: { fr: 'jours', es: 'días', zh: '天' },
	'days left': { fr: 'jours restants', es: 'días restantes', zh: '天剩余' },
	'autobatch ON': { fr: 'autolot ACTIVÉ', es: 'autolote ON', zh: '自动批处理 开' },
	'autobatch off': { fr: 'autolot désactivé', es: 'autolote off', zh: '自动批处理 关' },
	'autobatch mode': { fr: 'mode autolot', es: 'modo autolote', zh: '自动批处理模式' },
	error: { fr: 'erreur', es: 'error', zh: '错误' },
	// --- runner / copilot sub-labels ---
	'(click harness/model to pick, [e] renames)': { fr: '(cliquez harnais/modèle, [e] renomme)', es: '(clic harness/modelo, [e] renombra)', zh: '(点击框架/模型选择, [e] 重命名)' },
	'runners + quota: agent tab': { fr: 'exécuteurs + quota : onglet agent', es: 'ejecutores + cuota: pestaña agente', zh: '执行器 + 配额：智能体标签' },
	autobatch: { fr: 'autolot', es: 'autolote', zh: '自动批处理' },
	mode: { fr: 'mode', es: 'modo', zh: '模式' },
	'i: send   p: prompt': { fr: 'i : envoyer   p : invite', es: 'i: enviar   p: instrucción', zh: 'i: 发送   p: 提示词' },
	// --- interactive controls + action confirmations ---
	selected: { fr: 'sélectionnés', es: 'seleccionados', zh: '项已选' },
	'> launch: check a ticket first': { fr: '> lancer : cochez un ticket', es: '> lanzar: marque un ticket', zh: '> 启动：先勾选一个工单' },
	launched: { fr: 'lancé', es: 'lanzados', zh: '已启动' },
	're-launched': { fr: 'relancé', es: 'relanzado', zh: '已重启' },
	'merged PR': { fr: 'PR fusionnée', es: 'PR fusionada', zh: '已合并 PR' },
	'killed agent on': { fr: 'agent tué sur', es: 'agente matado en', zh: '已终止智能体：' },
	// --- modal titles ---
	'settings · appearance': { fr: 'réglages · apparence', es: 'ajustes · apariencia', zh: '设置 · 外观' },
	'tracker + projects': { fr: 'suivi + projets', es: 'rastreador + proyectos', zh: '追踪器 + 项目' },
	'matrix rain': { fr: 'pluie matrix', es: 'lluvia matrix', zh: '矩阵雨' },
	close: { fr: 'fermer', es: 'cerrar', zh: '关闭' },
	'esc saves': { fr: 'échap enregistre', es: 'esc guarda', zh: 'esc 保存' },
	// --- top status bar ---
	'no active run': { fr: 'aucune exécution active', es: 'sin ejecución activa', zh: '无活动运行' },
	RUNNING: { fr: 'EN COURS', es: 'EN CURSO', zh: '运行中' },
	idle: { fr: 'inactif', es: 'inactivo', zh: '空闲' },
	run: { fr: 'exéc', es: 'ejec', zh: '运行' },
	up: { fr: 'actif', es: 'activo', zh: '时长' },
	agents: { fr: 'agents', es: 'agentes', zh: '智能体' },
	failed: { fr: 'échoués', es: 'fallidos', zh: '失败' },
	merged: { fr: 'fusionnés', es: 'fusionados', zh: '已合并' },
	watching: { fr: 'surveille', es: 'vigilando', zh: '监视中' },
	trk: { fr: 'suivi', es: 'rastr', zh: '追踪' },
	// --- copilot / agent chat pane ---
	you: { fr: 'vous', es: 'tú', zh: '你' },
	copilot: { fr: 'copilote', es: 'copiloto', zh: '副驾' },
	quota: { fr: 'quota', es: 'cuota', zh: '配额' },
	'press i to chat with the agent': { fr: 'appuyez sur i pour discuter avec l’agent', es: 'pulse i para chatear con el agente', zh: '按 i 与智能体对话' },
	'copilot is working...': { fr: 'le copilote travaille...', es: 'el copiloto trabaja...', zh: '副驾工作中...' },
	'Ask me to inspect or manage the swarm, e.g.\n  what is the current run?\n  enable claude sonnet at cap 3\n  retry 42': {
		fr: 'Demandez-moi d’inspecter ou gérer l’essaim, p. ex.\n  quelle est l’exécution en cours ?\n  activer claude sonnet au plafond 3\n  relancer 42',
		es: 'Pídeme inspeccionar o gestionar el enjambre, p. ej.\n  ¿cuál es la ejecución actual?\n  activar claude sonnet con límite 3\n  reintentar 42',
		zh: '让我检查或管理集群，例如\n  当前运行是什么？\n  以上限 3 启用 claude sonnet\n  重试 42',
	},
	// --- backlog detail pane ---
	'click or arrow to a backlog ticket to see it': { fr: 'cliquez ou fléchez un ticket du backlog pour le voir', es: 'haga clic o navegue a un ticket para verlo', zh: '点击或用方向键选择待办工单以查看' },
	assigned: { fr: 'assigné', es: 'asignado', zh: '已分配' },
	'(no description)': { fr: '(aucune description)', es: '(sin descripción)', zh: '(无描述)' },
	'select a ticket': { fr: 'sélectionnez un ticket', es: 'seleccione un ticket', zh: '选择一个工单' },
	'(enter/click cycles)': { fr: '(entrée/clic défile)', es: '(enter/clic cicla)', zh: '(回车/点击 切换)' },
	'no projects (adapter not configured)': { fr: 'aucun projet (adaptateur non configuré)', es: 'sin proyectos (adaptador no configurado)', zh: '无项目（适配器未配置）' },
	// --- ticket meta line ---
	pid: { fr: 'pid', es: 'pid', zh: '进程' },
	elapsed: { fr: 'écoulé', es: 'transcurrido', zh: '用时' },
	'(m: merge)': { fr: '(m: fusionner)', es: '(m: fusionar)', zh: '(m: 合并)' },
	'[k: kill]': { fr: '[k: tuer]', es: '[k: matar]', zh: '[k: 终止]' },
	'[r: re-launch]': { fr: '[r: relancer]', es: '[r: relanzar]', zh: '[r: 重启]' },
};

// Alongside the TUI's other persisted config (token, ui.json) in the shared state dir.
const LOCALE_FILE = join(STATE_DIR, 'locale');
let LOCALE = 'en';
try { if (existsSync(LOCALE_FILE)) { const v = readFileSync(LOCALE_FILE, 'utf8').trim(); if (LOCALES.includes(v)) LOCALE = v; } } catch {}

export const getLocale = () => LOCALE;
export const setLocale = (l) => { if (LOCALES.includes(l)) { LOCALE = l; try { writeFileSync(LOCALE_FILE, LOCALE); } catch {} } return LOCALE; };
export const cycleLocale = () => setLocale(LOCALES[(LOCALES.indexOf(LOCALE) + 1) % LOCALES.length]);

// Translate one plain string. English passes through; matrix ciphers it; others look it up and fall
// back to English. Operates on plain text only - call it BEFORE wrapping the result in color tags.
export function t(s) {
	if (s == null || s === '') return s;
	if (LOCALE === 'en') return s;
	if (LOCALE === 'mx') return matrixize(s);
	const row = DICT[s];
	return (row && row[LOCALE]) || s;
}
