/**
 * Browser half of dsh-lemonade-provider: the "Lemonade" conversation view tab
 * implementing the Lemonade-specific API entry points through the host proxy
 * at /dsh-lemonade/api (same origin, keys host-side).
 *
 * All user-facing copy is English by default through the EN dictionary below
 * and is registered with the dsh locale service (i18n = swap
/replace the
 * dictionary or add locales). Shipped in the module-loader factory format.
 */
window.__ModuleLoader__.load({
	id: "@cmarin/dsh-lemonade",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useCallback } = React;
		const h = React.createElement;

		const API = "/dsh-lemonade/api";
		const NS = "llm-lemonade";
		const LOCALE_NS = "lemonade";

		/** English dictionary (default). Add locales alongside or replace. */
		const EN = {
			tabLabel: "Lemonade",
			title: "Lemonade Server",
			online: "Online",
			offline: "Offline",
			keyMissing: "Key missing",
			refresh: "Refresh",
			loading: "Loading...",
			autoOn: "Auto 10s \u25cf",
			autoOff: "Auto 10s \u25cb",
			keyMissingBanner: "API key missing — configure it in Settings > Models > Lemonade. ",
			serverUnreachableBanner: "Server unreachable. ",
			lastRequest: "Last request (v1/stats)",
			hostTitle: "Host (v1/system-stats)",
			ttft: "TTFT",
			tokPerSec: "tokens/s",
			inOut: "in / out",
			prompt: "prompt",
			cpu: "CPU",
			ram: "RAM",
			gpu: "GPU",
			vram: "VRAM",
			na: "n/a",
			systemDetails: "System details",
			systemInfo: "System info",
			models: "Models",
			modelsTooltip: "Models served by the Lemonade server",
			downloaded: "Downloaded",
			all: "All",
			onlyDownloaded: "Only downloaded",
			checkUpdates: "Check updates",
			add: "+ Add",
			close: "Close",
			noModels: "No models.",
			thModel: "Model",
			thRecipe: "Recipe",
			thSize: "Size",
			thState: "State",
			thActions: "Actions",
			loaded: "loaded",
			notLoaded: "not loaded",
			toDownload: "to download",
			updateBadge: "update",
			load: "Load",
			unload: "Unload",
			download: "Download",
			files: "Files",
			delete: "Delete",
			modelLoaded: "Model loaded",
			modelUnloaded: "Model unloaded",
			downloadStarted: "Download started",
			modelDeleted: "Model deleted",
			confirmDeleteModel: "Delete model {model} ?",
			updatesNotice: "{count} update(s) available: {models}",
			noModelsPinned: "No models pinned yet; fetch the server catalog and select the ones to use in dsh.",
			addModel: "Add a model (Hugging Face / ModelScope catalog)",
			searchPlaceholder: "search (≥ 3 characters)",
			search: "Search",
			noResults: "No results.",
			install: "Install",
			downloadsTitle: "Downloads",
			noDownloads: "No active downloads.",
			downloadProgress: "{percent} % · {bytes}",
			fileProgress: " · file {index}/{total}",
			pause: "Pause",
			cancel: "Cancel",
			remove: "Remove",
			runningSuffix: "\u00b7 running",
			downloadPaused: "Download paused",
			downloadCancelled: "Download cancelled",
			entryRemoved: "Entry removed",
			aliasesTitle: "Aliases",
			aliasesTooltip: "Internal endpoints /internal/* — authenticated via LEMONADE_ADMIN_API_KEY",
			aliasPlaceholder: "alias",
			targetPlaceholder: "target (model or canonical id)",
			link: "Link",
			list: "List",
			flushTelemetry: "Flush telemetry",
			noAliases: "No active aliases.",
			confirmDeleteAlias: "Delete alias {alias} ?",
			aliasLinked: "Alias linked",
			telemetryFlushed: "Telemetry flushed",
			aliasDeleted: "Alias deleted",
			downloadedSuffix: " (downloaded)",
			filesNone: "No local files.",
			missingSuffix: " (missing)",
		};

		/** Lookup + {param} interpolation; English is the default fallback. */
		function makeT(dict) {
			return function t(key, params) {
				let value = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
				if (params) {
					for (const k of Object.keys(params)) {
						value = value.split("{" + k + "}").join(String(params[k]));
					}
				}
				return value;
			};
		}
		const fallbackT = makeT(EN);

		/** Same-origin call to the host proxy; returns the normalized wire result. */
		async function apiCall(op, segments, queryObj, method, bodyObj) {
			let url = API + "/" + op;
			if (segments && segments.length) {
				for (const part of segments) url += "/" + encodeURIComponent(part);
			}
			if (queryObj) {
				const params = new URLSearchParams();
				for (const key of Object.keys(queryObj)) {
					const value = queryObj[key];
					if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
				}
				const qs = params.toString();
				if (qs.length) url += "?" + qs;
			}
			const init = { method: method || "GET", headers: {} };
			if (bodyObj !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(bodyObj);
			}
			try {
				const res = await fetch(url, init);
				const data = await res.json().catch(() => null);
				return data;
			} catch (e) {
				return { ok: false, error: { message: String((e && e.message) || e), code: "CLIENT" } };
			}
		}

		const fmt = (value) => (value === undefined || value === null ? "—" : String(value));
		const fmtNum = (value) => (typeof value === "number" ? String(Math.round(value * 10) / 10) : "—");
		function fmtBytes(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "—";
			if (n >= 1073741824) return String(Math.round((n / 1073741824) * 10) / 10) + " GB";
			if (n >= 1048576) return String(Math.round((n / 1048576) * 10) / 10) + " MB";
			return String(n) + " B";
		}
		const errMsg = (res) => (res && res.error ? (res.error.message || res.error.code || "Error") : "Unknown error");

		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "12px", padding: "16px 20px", color: "var(--dsw-alias-label-primary, #1f2329)", maxWidth: 860 },
			header: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
			title: { margin: "0", fontSize: "16px", fontWeight: 600 },
			badge: { borderRadius: "10px", padding: "2px 8px", fontSize: "12px", fontWeight: 600, lineHeight: "18px" },
			badgeOk: { background: "rgba(26,127,55,0.12)", color: "#1a7f37" },
			badgeWarn: { background: "rgba(191,144,0,0.16)", color: "#9a6700" },
			badgeBad: { background: "rgba(209,36,47,0.12)", color: "#d1242f" },
			muted: { margin: "0", fontSize: "12px", lineHeight: "16px", opacity: 0.7 },
			button: { padding: "4px 10px", fontSize: "13px", lineHeight: "18px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, #d0d7de)", background: "var(--dsw-alias-bg, #fff)", cursor: "pointer", color: "inherit" },
			buttonPrimary: { padding: "4px 12px", fontSize: "13px", lineHeight: "18px", borderRadius: "6px", border: "none", background: "#1a7f37", color: "#fff", cursor: "pointer" },
			buttonDanger: { padding: "4px 10px", fontSize: "13px", lineHeight: "18px", borderRadius: "6px", border: "1px solid rgba(209,36,47,0.5)", background: "transparent", color: "#d1242f", cursor: "pointer" },
			card: { border: "1px solid var(--dsw-alias-border-l2, #d0d7de)", borderRadius: "10px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: "6px" },
			cardTitle: { margin: "0", fontSize: "13px", fontWeight: 600, lineHeight: "18px" },
			twoCol: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" },
			kv: { display: "flex", justifyContent: "space-between", fontSize: "13px", lineHeight: "20px" },
			table: { borderCollapse: "collapse", width: "100%", fontSize: "13px" },
			th: { textAlign: "left", fontSize: "11px", textTransform: "uppercase", opacity: 0.6, padding: "4px 6px", borderBottom: "1px solid var(--dsw-alias-border-l2, #d0d7de)" },
			td: { padding: "6px", borderBottom: "1px solid var(--dsw-alias-border-l2, #d0d7de)", verticalAlign: "top" },
			chip: { display: "inline-block", borderRadius: "4px", padding: "0 5px", fontSize: "11px", lineHeight: "16px", border: "1px solid var(--dsw-alias-border-l3, #d0d7de)", marginRight: "4px" },
			input: { boxSizing: "border-box", padding: "5px 8px", fontSize: "13px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l2, #d0d7de)", background: "var(--dsw-alias-bg, #fff)", color: "inherit" },
			notice: { margin: "0", fontSize: "12px", lineHeight: "16px", color: "#9a6700" },
			success: { margin: "0", fontSize: "12px", lineHeight: "16px", color: "#1a7f37" },
			error: { margin: "0", fontSize: "12px", lineHeight: "16px", color: "#d1242f" },
			progress: { height: "6px", borderRadius: "3px", background: "var(--dsw-alias-border-l2, #d0d7de)", position: "relative" },
			progressFill: { height: "6px", borderRadius: "3px", background: "#1a7f37" },
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			details: { fontSize: "13px" },
		};
		const el = (type, props, ...children) => h(type, props || {}, ...children);

		function LemonadeServerView(props) {
			const api = props.api;
			const t = props && typeof props.t === "function" ? props.t : fallbackT;
			const [health, setHealth] = useState(undefined);
			const [healthErr, setHealthErr] = useState(undefined);
			const [models, setModels] = useState(undefined);
			const [modelsOpen, setModelsOpen] = useState(false);
			const [onlyDownloaded, setOnlyDownloaded] = useState(true);
			const [filesById, setFilesById] = useState({});
			const [downloads, setDownloads] = useState(undefined);
			const [stats, setStats] = useState(undefined);
			const [sysStats, setSysStats] = useState(undefined);
			const [sysInfo, setSysInfo] = useState(undefined);
			const [serverURL, setServerURL] = useState("http://localhost:13305/api");
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(undefined);
			const [notice, setNotice] = useState(undefined);
			const [updates, setUpdates] = useState(undefined);
			const [showAdd, setShowAdd] = useState(false);
			const [searchText, setSearchText] = useState("");
			const [searchResults, setSearchResults] = useState(undefined);
			const [adding, setAdding] = useState(false);
			const [aliases, setAliases] = useState(undefined);
			const [aliasAlias, setAliasAlias] = useState("");
			const [aliasTarget, setAliasTarget] = useState("");
			const [adminOpen, setAdminOpen] = useState(true);
			const [autoRefresh, setAutoRefresh] = useState(true);

			const loadHealth = useCallback(async () => {
				const res = await apiCall("health");
				if (res && res.ok) { setHealth(res.value); setHealthErr(undefined); }
				else { setHealth(undefined); setHealthErr(res && res.error ? res.error : { message: "hors ligne", code: "TRANSPORT" }); }
			}, []);
			const loadTelemetry = useCallback(async () => {
				const [s1, s2] = await Promise.all([apiCall("stats"), apiCall("systemStats")]);
				if (s1 && s1.ok) setStats(s1.value);
				if (s2 && s2.ok) setSysStats(s2.value);
			}, []);
			const loadModels = useCallback(async () => {
				const res = await apiCall("models", [], { show_all: "true" });
				if (res && res.ok) {
					const data = res.value && Array.isArray(res.value.data) ? res.value.data : [];
					setModels(data);
				}
			}, []);
			const loadDownloads = useCallback(async () => {
				const res = await apiCall("downloads");
				if (res && res.ok) setDownloads(Array.isArray(res.value) ? res.value : []);
			}, []);
			const loadAliases = useCallback(async () => {
				const res = await apiCall("internalAliases");
				if (res && res.ok && res.value && Array.isArray(res.value.aliases)) setAliases(res.value.aliases);
			}, []);
			const loadAll = useCallback(async () => {
				setBusy(true); setError(undefined);
				await Promise.all([loadHealth(), loadTelemetry(), loadModels(), loadDownloads(), loadAliases()]);
				setBusy(false);
			}, [loadHealth, loadTelemetry, loadModels, loadDownloads, loadAliases]);
			useEffect(() => { loadAll(); }, [loadAll]);
			useEffect(() => {
				if (!autoRefresh) return;
				const timer = setInterval(() => { loadHealth(); loadTelemetry(); }, 10000);
				return () => clearInterval(timer);
			}, [autoRefresh, loadHealth, loadTelemetry]);
			useEffect(() => {
				if (!api || !api.settings) return;
				api.settings.describe({}).then((response) => {
					const view = response && response.result && response.result.ok ? response.result.value : undefined;
					if (!view) return;
					const found = (view.namespaces || []).find((n) => n.ns === NS);
					if (found && found.value) {
						if (typeof found.value.baseURL === "string" && found.value.baseURL.length) setServerURL(found.value.baseURL);
					}
				}).catch(() => {});
			}, [api]);

			const run = async (fn, okMessage) => {
				setBusy(true); setError(undefined); setNotice(undefined); setUpdates(undefined);
				try { await fn(); } catch (e) { setError(String((e && e.message) || e)); }
				if (okMessage) setNotice(okMessage);
				await loadAll();
				setBusy(false);
			};

			const loadedByModel = (id) => (health && Array.isArray(health.all_models_loaded) ? health.all_models_loaded : []).find((m) => m.model_name === id);

			// The tab lists every model the server advertises, optionally filtered
			// to downloaded ones (checkbox in the block header, checked by default).
			// Aliases are hidden: an alias is an entry whose name is in the alias
			// listing (GET /internal/aliases) or that carries a "model" field
			// pointing at its target (a real downloaded model never does).
			const aliasNames = new Set(
				(Array.isArray(aliases) ? aliases : [])
					.map((a) => (a ? (a.alias !== undefined ? a.alias : a.name) : undefined))
					.filter((v) => typeof v === "string" && v.length > 0),
			);
			const visibleModels = (Array.isArray(models) ? models : []).filter((m) => {
				if (m === null || typeof m !== "object") return false;
				if (typeof m.model === "string" && m.model.length > 0) return false;
				if (aliasNames.has(m.id) || aliasNames.has(m.name)) return false;
				return !onlyDownloaded || m.downloaded !== false;
			});

			const toggleFiles = async (id) => {
				if (filesById[id] !== undefined) {
					const next = { ...filesById };
					delete next[id];
					setFilesById(next);
					return;
				}
				const res = await apiCall("modelFiles", [id]);
				if (res && res.ok) setFilesById((prev) => ({ ...prev, [id]: res.value && Array.isArray(res.value.files) ? res.value.files : [] }));
				else setError(errMsg(res));
			};

			const doSearch = async () => {
				setAdding(true); setError(undefined); setSearchResults(undefined); setUpdates(undefined);
				const query = searchText.trim();
				const res = await apiCall("registrySearch", [], { query, format: "gguf" });
				if (res && res.ok) setSearchResults(res.value && Array.isArray(res.value.results) ? res.value.results : []);
				else setError(errMsg(res));
				setAdding(false);
			};

			const doPull = async (repositoryId) => {
				setAdding(true); setError(undefined);
				// Conformant pull flow (spec): variants -> model_name/recipe/checkpoint.
				let modelName = "user." + String(repositoryId).split("/").pop();
				let recipe = "llamacpp";
				let checkpoint = repositoryId;
				const v = await apiCall("pullVariants", [], { checkpoint: repositoryId });
				if (v && v.ok && v.value) {
					if (typeof v.value.suggested_name === "string" && v.value.suggested_name.length) modelName = "user." + v.value.suggested_name;
					if (typeof v.value.recipe === "string" && v.value.recipe.length) recipe = v.value.recipe;
					const variants = Array.isArray(v.value.variants) ? v.value.variants : [];
					if (variants.length > 0 && variants[0] && typeof variants[0].name === "string" && variants[0].name.length) {
						checkpoint = repositoryId + ":" + variants[0].name;
					}
				}
				const res = await apiCall("pull", [], undefined, "POST", { model_name: modelName, recipe, checkpoint });
				if (res && res.ok) { setNotice(t("downloadStarted")); setShowAdd(false); setSearchResults(undefined); setSearchText(""); loadDownloads(); }
				else setError(errMsg(res));
				setAdding(false);
			};

			const healthOk = health !== undefined && health.status === "ok";
			let badgeKey = "offline";
			if (healthOk) badgeKey = "online";
			else if (healthErr && healthErr.code === "MISSING_CREDENTIAL") badgeKey = "keyMissing";

			return el("div", { style: styles.wrap },
				// ---- header ----
				el("div", { style: styles.header },
					el("h2", { style: styles.title }, t("title")),
					el("span", { style: { ...styles.badge, ...(badgeKey === "online" ? styles.badgeOk : badgeKey === "keyMissing" ? styles.badgeWarn : styles.badgeBad) } }, "● " + t(badgeKey)),
					el("span", { style: styles.muted }, health && health.version ? "v" + health.version : ""),
					el("button", { style: styles.button, disabled: busy, onClick: () => loadAll() }, busy ? t("loading") : t("refresh")),
					el("button", { style: styles.button, disabled: busy, onClick: () => setAutoRefresh((v) => !v) }, t(autoRefresh ? "autoOn" : "autoOff")),
				),
				el("p", { style: styles.muted }, serverURL),
				healthErr && !healthOk ? el("p", { style: styles.error },
					(healthErr.code === "MISSING_CREDENTIAL" ? t("keyMissingBanner") : t("serverUnreachableBanner")) + errMsg({ error: healthErr })) : null,

				// ---- telemetry ----
				el("div", { style: styles.twoCol },
					el("div", { style: styles.card },
						el("h3", { style: styles.cardTitle }, t("lastRequest")),
						kv(t("ttft"), stats ? fmtNum(stats.time_to_first_token) + " s" : "—"),
						kv(t("tokPerSec"), stats ? fmtNum(stats.tokens_per_second) + " tok/s" : "—"),
						kv(t("inOut"), stats ? fmt(stats.input_tokens) + " / " + fmt(stats.output_tokens) : "—"),
						kv(t("prompt"), stats ? fmt(stats.prompt_tokens) : "—"),
					),
					el("div", { style: styles.card },
						el("h3", { style: styles.cardTitle }, t("hostTitle")),
						kv(t("cpu"), sysStats ? fmtNum(sysStats.cpu_percent) + " %" : "—"),
						kv(t("ram"), sysStats ? fmtNum(sysStats.memory_gb) + " GB" : "—"),
						kv(t("gpu"), sysStats && sysStats.gpu_percent !== null ? fmtNum(sysStats.gpu_percent) + " %" : t("na")),
						kv(t("vram"), sysStats && sysStats.vram_gb !== null ? fmtNum(sysStats.vram_gb) + " GB" : t("na")),
						sysStats === undefined ? el("button", { style: styles.button, onClick: async () => { const r = await apiCall("systemInfo"); if (r && r.ok) setSysInfo(r.value); else setError(errMsg(r)); } }, t("systemDetails")) : null,
						sysInfo ? el("details", { style: styles.details },
							el("summary", null, t("systemInfo")),
							el("pre", { style: { fontSize: "11px", whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto", margin: "4px 0" } }, JSON.stringify(sysInfo, null, 2)),
						) : null,
					),
				),

				// ---- models ----
				el("details", { style: { ...styles.card, marginTop: 0 }, open: modelsOpen, onToggle: (e) => setModelsOpen(e.target.open) },
					el("summary", { style: { ...styles.cardTitle, cursor: "pointer" }, title: t("modelsTooltip") }, t("models") + (Array.isArray(visibleModels) ? " (" + visibleModels.length + ")" : "")),
					el("div", { style: styles.row, justifyContent: "flex-end" },
						el("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "13px" } },
							el("input", { type: "checkbox", checked: onlyDownloaded === true, onChange: (e) => setOnlyDownloaded(e.target.checked) }),
							t("onlyDownloaded"),
						),
						el("button", { style: styles.button, disabled: busy, onClick: async () => { const r = await apiCall("checkUpdates", [], undefined, "POST"); if (r && r.ok) setUpdates(r.value); else setError(errMsg(r)); } }, t("checkUpdates")),
						el("button", { style: styles.button, disabled: busy, onClick: () => setShowAdd((v) => !v) }, showAdd ? t("close") : t("add")),
					),
					updates ? el("p", { style: styles.notice }, t("updatesNotice", { count: updates.updates_available || 0, models: Array.isArray(updates.models) ? updates.models.join(", ") : "" })) : null,
					Array.isArray(visibleModels) && visibleModels.length === 0 ? el("p", { style: styles.muted }, t("noModels")) : null,
					Array.isArray(visibleModels) && visibleModels.length > 0 ? el("table", { style: styles.table },
						el("thead", null, el("tr", null,
							el("th", { style: styles.th }, t("thModel")),
							el("th", { style: styles.th }, t("thRecipe")),
							el("th", { style: styles.th }, t("thSize")),
							el("th", { style: styles.th }, t("thState")),
							el("th", { style: styles.th }, t("thActions")),
						)),
						el("tbody", null, visibleModels.map((m) => {
							const loaded = loadedByModel(m.id);
							return el("tr", { key: m.id },
								el("td", { style: styles.td },
									el("span", null, m.id),
									m.update_available ? el("span", { style: { ...styles.chip, borderColor: "#9a6700", color: "#9a6700" } }, t("updateBadge")) : null,
								),
								el("td", { style: styles.td }, m.recipe ? el("span", { style: styles.chip }, m.recipe) : ""),
								el("td", { style: styles.td }, typeof m.size === "number" ? String(m.size) : "—"),
								el("td", { style: styles.td },
									loaded ? el("span", { style: { ...styles.chip, background: "rgba(26,127,55,0.1)", color: "#1a7f37" } }, t("loaded")) : el("span", { style: styles.chip }, t("notLoaded")),
									m.downloaded === false ? el("span", { style: styles.chip }, t("toDownload")) : null,
								),
								el("td", { style: styles.td },
									el("div", { style: styles.row },
										loaded ? el("button", { style: styles.button, disabled: busy, onClick: () => run(async () => { const r = await apiCall("unload", [], undefined, "POST", { model: m.id }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("modelUnloaded")) }, t("unload"))
											: m.downloaded === false ? el("button", { style: styles.button, disabled: busy, onClick: () => run(async () => { const r = await apiCall("pull", [], undefined, "POST", { checkpoint: m.id }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("downloadStarted")) }, t("download"))
											: el("button", { style: styles.button, disabled: busy, onClick: () => run(async () => { const r = await apiCall("load", [], undefined, "POST", { model: m.id }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("modelLoaded")) }, t("load")),
										el("button", { style: styles.button, disabled: busy, onClick: () => toggleFiles(m.id) }, t("files")),
										el("button", { style: styles.buttonDanger, disabled: busy, onClick: () => { if (confirm(t("confirmDeleteModel", { model: m.id }))) run(async () => { const r = await apiCall("delete", [], undefined, "POST", { model: m.id }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("modelDeleted")); } }, t("delete")),
									),
									filesById[m.id] !== undefined ? divFiles(filesById[m.id], t) : null,
								),
							);
						})),
					) : null,
					showAdd ? addModelCard(styles, el, searchText, setSearchText, searchResults, adding, doSearch, doPull, setShowAdd, t) : null,
				),

				// ---- admin (aliases) ----
				el("details", { style: { ...styles.card, marginTop: 0 }, open: adminOpen, onToggle: (e) => setAdminOpen(e.target.open) },
					el("summary", { style: { ...styles.cardTitle, cursor: "pointer" }, title: t("aliasesTooltip") }, t("aliasesTitle")),
					el("div", { style: styles.row },
						el("input", { style: { ...styles.input, flex: 1, minWidth: 200 }, placeholder: t("aliasPlaceholder"), value: aliasAlias, onChange: (e) => setAliasAlias(e.target.value) }),
						el("input", { style: { ...styles.input, flex: 2, minWidth: 220 }, placeholder: t("targetPlaceholder"), value: aliasTarget, onChange: (e) => setAliasTarget(e.target.value) }),
						el("button", { style: styles.buttonPrimary, disabled: busy || !aliasAlias.trim() || !aliasTarget.trim(), onClick: () => run(async () => {
							const r = await apiCall("internalAliasesSet", [], undefined, "POST", { alias: aliasAlias.trim(), target: aliasTarget.trim() });
							if (!r || !r.ok) throw new Error(errMsg(r));
							setAliasAlias(""); setAliasTarget("");
							const l = await apiCall("internalAliases");
							if (l && l.ok) setAliases(l.value && Array.isArray(l.value.aliases) ? l.value.aliases : []);
						}, t("aliasLinked")) }, t("link")),
						el("button", { style: styles.button, disabled: busy, onClick: async () => { const l = await apiCall("internalAliases"); if (l && l.ok) setAliases(l.value && Array.isArray(l.value.aliases) ? l.value.aliases : []); else setError(errMsg(l)); } }, t("list")),
						el("button", { style: styles.button, disabled: busy, onClick: () => run(async () => { const r = await apiCall("internalTelemetryFlush", [], undefined, "POST"); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("telemetryFlushed")) }, t("flushTelemetry")),
					),
					Array.isArray(aliases) && aliases.length === 0 ? el("p", { style: styles.muted }, t("noAliases")) : null,
					Array.isArray(aliases) && aliases.length > 0 ? el("ul", { style: { margin: "4px 0 0 0", padding: 0, listStyle: "none" } },
						aliases.map((al) => el("li", { key: al.alias, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, #d0d7de)" } },
							el("span", { style: { fontSize: "13px" } }, String(al.alias) + " → " + String(al.target || al.model || "") + (al.downloaded === true ? t("downloadedSuffix") : "")),
							el("button", { style: styles.buttonDanger, disabled: busy, onClick: () => { if (confirm(t("confirmDeleteAlias", { alias: al.alias }))) run(async () => { const r = await apiCall("internalAliasesDelete", [al.alias]); if (!r || !r.ok) throw new Error(errMsg(r)); setAliases((prev) => Array.isArray(prev) ? prev.filter((x) => x.alias !== al.alias) : prev); }, t("aliasDeleted")); } }, t("delete")),
						))) : null,
				),


				// ---- downloads ---- (refreshed by the tab-wide refresh button)
				el("div", { style: styles.card },
					el("h3", { style: styles.cardTitle }, t("downloadsTitle")),
					Array.isArray(downloads) && downloads.length === 0 ? el("p", { style: styles.muted }, t("noDownloads")) : null,
					Array.isArray(downloads) ? downloads.map((job) => downloadRow(job, busy, run, loadDownloads, styles, el, t)) : null,
				),

				error !== undefined ? el("p", { style: styles.error }, String(error)) : null,
				notice !== undefined ? el("p", { style: styles.success }, String(notice)) : null,
			);
		}

		function kv(label, value) {
			return el("div", { style: styles.kv }, el("span", { style: styles.muted }, label), el("span", null, value));
		}
		const pct = (job) => (typeof job.percent === "number" ? Math.max(0, Math.min(100, Math.round(job.percent))) : (job.complete ? 100 : 0));
		function downloadRow(job, busy, run, reload, st, h2, t) {
			const percent = pct(job);
			const bytes = fmtBytes(job.bytes_downloaded) + " / " + fmtBytes(job.bytes_total);
			const fileInfo = typeof job.total_files === "number" ? t("fileProgress", { index: fmt(job.file_index), total: fmt(job.total_files) }) : "";
			return h2("div", { key: job.id },
				h2("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "13px" } },
					h2("span", null, job.model_name || job.id),
					h2("span", { style: st.muted }, job.status + (job.running ? " " + t("runningSuffix") : "")),
				),
				h2("div", { style: st.progress }, h2("div", { style: { ...st.progressFill, width: percent + "%" } })),
				h2("p", { style: st.muted }, t("downloadProgress", { percent: percent, bytes: bytes }) + fileInfo),
				h2("div", { style: styles.row },
					job.running ? h2("button", { style: st.button, disabled: busy, onClick: () => run(async () => { const r = await apiCall("downloadsControl", [], undefined, "POST", { id: job.id, action: "pause" }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("downloadPaused")) }, t("pause")) : null,
					h2("button", { style: st.button, disabled: busy, onClick: () => run(async () => { const r = await apiCall("downloadsControl", [], undefined, "POST", { id: job.id, action: "cancel" }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("downloadCancelled")) }, t("cancel")),
					!job.running ? h2("button", { style: st.buttonDanger, disabled: busy, onClick: () => run(async () => { const r = await apiCall("downloadsControl", [], undefined, "POST", { id: job.id, action: "remove" }); if (!r || !r.ok) throw new Error(errMsg(r)); }, t("entryRemoved")) }, t("remove")) : null,
				),
			);
		}
		function divFiles(files, t) {
			if (!Array.isArray(files) || files.length === 0) return el("p", { style: styles.muted }, t("filesNone"));
			return el("ul", { style: { margin: "4px 0 0 0", paddingLeft: "16px", fontSize: "12px" } },
				files.map((f) => el("li", { key: f.name },
					f.name + (f.role && f.role !== "main" ? " (" + f.role + ")" : "") + " — " + fmtBytes(f.size_bytes) + (f.exists ? "" : t("missingSuffix")),
				)),
			);
		}
		function addModelCard(st, h2, searchText, setSearchText, results, adding, doSearch, doPull, setShowAdd, t) {
			return h2("div", { style: { ...st.card, background: "var(--dsw-alias-bg-secondary, #f6f8fa)" } },
				h2("h4", { style: st.cardTitle }, t("addModel")),
				h2("div", { style: styles.row },
					h2("input", { style: { ...st.input, flex: 1, minWidth: 220 }, placeholder: t("searchPlaceholder"), value: searchText, onChange: (e) => setSearchText(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") doSearch(); } }),
					h2("button", { style: st.buttonPrimary, disabled: adding || searchText.trim().length < 3, onClick: doSearch }, t("search")),
				),
				typeof results === "object" && results !== null && results.length === 0 ? h2("p", { style: st.muted }, t("noResults")) : null,
				Array.isArray(results) && results.length > 0 ? h2("ul", { style: { margin: "4px 0 0 0", padding: 0, listStyle: "none" } },
					results.map((r2) => h2("li", { key: r2.repository_id, style: { padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-border-l2, #d0d7de)" } },
						h2("div", { style: styles.row, justifyContent: "space-between" },
							h2("div", null,
								h2("div", { style: { fontSize: "13px", fontWeight: 600 } }, r2.display_name || r2.repository_id),
								h2("div", { style: st.muted }, String(r2.repository_id) + (r2.description ? " — " + r2.description : "")),
							),
							h2("div", { style: styles.row },
								h2("span", { style: st.muted }, "♥ " + fmt(r2.likes) + " · ⬇ " + fmt(r2.downloads)),
								h2("button", { style: st.button, disabled: adding, onClick: () => doPull(r2.repository_id) }, t("install")),
							),
						),
					))) : null,
			);
		}

		/** Register the Lemonade conversation view tab (next to Chat/Trajectory). */
		function apply(ctx) {
			const slots = ctx.get("slots");
			const connection = ctx.get("connection");
			if (slots === undefined || connection === undefined) return;
			// i18n: register the dictionary with the dsh locale service and bind
			// its translator (en + zh both point at EN, so English is the default
			// in every preference); fall back to EN-only when locale is absent.
			let viewT = fallbackT;
			const locale = ctx.get("locale");
			if (locale !== undefined && typeof locale.register === "function" && typeof locale.bind === "function") {
				try {
					locale.register(LOCALE_NS, { en: EN, zh: EN });
					viewT = locale.bind(LOCALE_NS);
				} catch (err) {
					viewT = fallbackT;
				}
			}
			slots.inject("conversation.view", () => slots.register(
				{
					name: "conversation.view",
					id: "lemonade",
					order: 10,
					label: () => viewT("tabLabel"),
					inject: () => ({ api: connection.api, t: viewT }),
				},
				LemonadeServerView,
			));
		}
		var inject = ["slots", "connection"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
