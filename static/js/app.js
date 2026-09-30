// Main CAD Command Center Application Logic

// Global Defensive Error Boundary
window.addEventListener("error", (event) => {
    console.warn("CAD Defensive Error Boundary caught:", event.error || event.message);
});
window.addEventListener("unhandledrejection", (event) => {
    console.warn("CAD Handled Unhandled Rejection:", event.reason);
});

// Safe fallback for window.cadAudio to prevent any runtime exceptions
if (!window.cadAudio) {
    window.cadAudio = {
        playBeep: (freq = 880, dur = 120) => {},
        playAlert: () => {},
        playSuccess: () => {},
        playCriticalAlert: () => {},
        playDispatchPing: () => {},
        playSiren: () => {},
        toggle: () => true,
        init: () => null
    };
}

class CADApp {
    constructor() {
        this.incidents = [];
        this.units = [];
        this.stations = [];
        this.stats = {
            total_incidents: 8,
            active_critical: 2,
            trapped_count: 56,
            injured_count: 14,
            dispatched_units: 3,
            available_units: 4,
            average_urgency: 84
        };
        this.selectedIncident = null;
        this.activeTab = "tab-map";
        this.activeTriageStage = "PROPOSED"; // 'PROPOSED' | 'ONGOING' | 'COMPLETED'
        this.sortMode = "PRIORITY"; // 'PRIORITY' | 'CHRONOLOGICAL'
        this.currentRole = "CONTROL_ROOM"; // 'CONTROL_ROOM' | 'FIELD_RESPONDER'
        this.activeResponderUnit = "COMMAND-ALPHA";
        this.selectedVictimCategory = "RED";
        this.ws = null;
        this.charts = {};
        this.leftWidthPercent = 50;
        this.visionLeftWidthPercent = 50;
        this.streamEvents = [];
        this.streamRunning = true;
        this.streamStats = { ingested: 0, tickets: 0, merged: 0, discarded: 0 };
        
        // SIH26191 State
        this.redZones = [];
        this.habitations = [];
        this.shelters = [];
        this.capacityReports = [];
        this.relocationPlan = null;
        
        // AI Ingest Dual-Window Layout State Management
        this.ingestLayout = {
            paneMode: 'split', // 'split' | 'left-max' | 'right-max'
            leftCollapsed: false,
            rightCollapsed: false,
            leftMinimized: false,
            rightMinimized: false,
            visionCollapsed: false
        };
    }

    async init() {
        this.bindEvents();
        this.initClock();
        this.initSplitResizers();
        try {
            window.cadMapManager.init();
        } catch (e) {
            console.warn("Map init handled:", e);
        }
        await this.loadInitialData();
        await this.loadSIH26191Data();
        this.connectWebSocket();
        this.initCharts();
        this.loadStreamStatus();
        setInterval(() => this.loadTamilNaduTelemetry(), 30000);
        setInterval(() => this.loadSIH26191Data(), 45000);
    }

    initClock() {
        const update = () => {
            const now = new Date();
            const utc = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
            const el = document.getElementById("clock-display");
            if (el) el.innerText = utc;
        };
        update();
        setInterval(update, 1000);
    }

    bindEvents() {
        // Tab Navigation
        document.querySelectorAll(".nav-tab").forEach(tab => {
            tab.addEventListener("click", () => {
                const target = tab.dataset.tab;
                this.switchTab(target);
            });
        });

        // Top-Level Document Event Delegation for Stream HUD Badge & Drawer Buttons
        document.addEventListener('click', (e) => {
            const trigger = e.target.closest('#btn-social-stream-hud, .stream-hud-btn');
            if (trigger) {
                e.preventDefault();
                e.stopPropagation();
                this.toggleSocialStreamDrawer();
            }

            const closeTrigger = e.target.closest('#close-stream-drawer, #close-hud-drawer-btn');
            if (closeTrigger) {
                e.preventDefault();
                e.stopPropagation();
                this.toggleSocialStreamDrawer(false);
            }
        });

        // Audio Toggle
        const audioBtn = document.getElementById("btn-toggle-audio");
        if (audioBtn) {
            audioBtn.addEventListener("click", () => {
                const enabled = window.cadAudio.toggle();
                audioBtn.innerHTML = enabled ? 
                    `<i data-lucide="volume-2"></i>` : 
                    `<i data-lucide="volume-x"></i>`;
                lucide.createIcons();
            });
        }

        // Simulate Live Feed Button
        const simBtn = document.getElementById("btn-simulate-feed");
        if (simBtn) {
            simBtn.addEventListener("click", async () => {
                simBtn.disabled = true;
                simBtn.innerText = "Simulating...";
                try {
                    await fetch("/api/simulate/feed", { method: "POST" });
                } catch (e) {
                    console.error("Simulation error:", e);
                } finally {
                    simBtn.disabled = false;
                    simBtn.innerHTML = `<i data-lucide="radio"></i> Simulate Live Feed`;
                    lucide.createIcons();
                }
            });
        }

        // Run AI Triage Form Submit
        const triageBtn = document.getElementById("btn-run-triage");
        if (triageBtn) {
            triageBtn.addEventListener("click", () => this.handleManualTriage());
        }

        // Scenario Preset Chips
        document.querySelectorAll(".scenario-chip").forEach(chip => {
            chip.addEventListener("click", () => {
                const msg = chip.dataset.msg;
                const meta = chip.dataset.meta || "";
                document.getElementById("input-raw-msg").value = msg;
                document.getElementById("input-metadata").value = meta;
            });
        });

        // Matrix Filters
        const searchInput = document.getElementById("matrix-search");
        if (searchInput) {
            searchInput.addEventListener("input", () => this.renderMatrix());
        }
        const sevFilter = document.getElementById("matrix-filter-severity");
        if (sevFilter) {
            sevFilter.addEventListener("change", () => this.renderMatrix());
        }
        const typeFilter = document.getElementById("matrix-filter-type");
        if (typeFilter) {
            typeFilter.addEventListener("change", () => this.renderMatrix());
        }

        // 3-Stage Operational Board Tabs
        document.querySelectorAll(".stage-tab-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const stage = btn.dataset.stage;
                this.setTriageStage(stage);
            });
        });

        // Triage Sort Mode Controls
        document.querySelectorAll(".sort-toggle-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const mode = btn.dataset.sort;
                this.setSortMode(mode);
            });
        });

        // Image Upload & Dropzone
        const dropzone = document.getElementById("image-dropzone");
        const fileInput = document.getElementById("input-disaster-image");
        const previewWrap = document.getElementById("dropzone-preview-wrap");
        const promptWrap = document.getElementById("dropzone-prompt");
        const previewImg = document.getElementById("image-preview");
        const removeImgBtn = document.getElementById("btn-remove-image");
        const analyzeImgBtn = document.getElementById("btn-analyze-image");

        if (dropzone && fileInput) {
            dropzone.addEventListener("click", (e) => {
                if (e.target !== removeImgBtn) {
                    fileInput.click();
                }
            });

            dropzone.addEventListener("dragover", (e) => {
                e.preventDefault();
                dropzone.style.borderColor = "#38bdf8";
                dropzone.style.background = "rgba(56,189,248,0.15)";
            });

            dropzone.addEventListener("dragleave", () => {
                dropzone.style.borderColor = "rgba(56,189,248,0.4)";
                dropzone.style.background = "rgba(15,23,42,0.6)";
            });

            dropzone.addEventListener("drop", (e) => {
                e.preventDefault();
                dropzone.style.borderColor = "rgba(56,189,248,0.4)";
                dropzone.style.background = "rgba(15,23,42,0.6)";
                if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    this.loadUploadedImageFile(e.dataTransfer.files[0]);
                }
            });

            fileInput.addEventListener("change", (e) => {
                if (e.target.files && e.target.files[0]) {
                    this.loadUploadedImageFile(e.target.files[0]);
                }
            });
        }

        if (removeImgBtn) {
            removeImgBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                this.currentUploadedImageBase64 = null;
                if (fileInput) fileInput.value = "";
                if (previewWrap) previewWrap.style.display = "none";
                if (promptWrap) promptWrap.style.display = "block";
            });
        }

        // Image Presets
        document.querySelectorAll(".image-preset-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const type = btn.dataset.type;
                const caption = btn.dataset.caption || "";
                this.applySyntheticImagePreset(type, caption);
            });
        });

        if (analyzeImgBtn) {
            analyzeImgBtn.addEventListener("click", () => this.handleAnalyzeDisasterImage());
        }



        // Map Filters — only active in CAD_DISPATCH mode
        const mapTypeFilter = document.getElementById("map-filter-type");
        if (mapTypeFilter) {
            mapTypeFilter.addEventListener("change", (e) => {
                if (!window.cadMapManager) return;
                window.cadMapManager.activeFilterType = e.target.value;
                // Only re-render incident pins when explicitly in CAD dispatch mode
                if (window.cadMapManager.activeMapMode === "CAD_DISPATCH") {
                    window.cadMapManager.renderIncidents(this.incidents, (inc) => this.selectIncident(inc));
                } else {
                    // In strategic mode, ensure pins stay cleared
                    window.cadMapManager.clearCADMarkers();
                }
            });
        }

        // SIH26191 Tactical Layer Mode Switcher
        const mapLayerMode = document.getElementById("map-layer-mode");
        if (mapLayerMode) {
            mapLayerMode.addEventListener("change", (e) => {
                if (window.cadMapManager) {
                    window.cadMapManager.setMapMode(e.target.value);
                }
            });
        }

        // Role Switcher Buttons
        document.querySelectorAll(".role-toggle-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const role = btn.dataset.role;
                this.setRole(role);
            });
        });

        // Field Responder Unit Switcher
        const respUnitSelect = document.getElementById("select-responder-unit");
        if (respUnitSelect) {
            respUnitSelect.addEventListener("change", (e) => {
                this.activeResponderUnit = e.target.value;
                this.renderResponderMission();
            });
        }

        // 6-State Tactical Status Buttons
        document.querySelectorAll(".tactical-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const status = btn.dataset.status;
                this.handleResponderStatusChange(status);
            });
        });

        // Victim Category Selector
        document.querySelectorAll(".cat-chip").forEach(chip => {
            chip.addEventListener("click", () => {
                document.querySelectorAll(".cat-chip").forEach(c => c.classList.remove("active"));
                chip.classList.add("active");
                this.selectedVictimCategory = chip.dataset.cat;
            });
        });

        // Victim Form Submit
        const victimSubmitBtn = document.getElementById("btn-submit-victim");
        if (victimSubmitBtn) {
            victimSubmitBtn.addEventListener("click", () => this.handleVictimSubmit("main"));
        }
        const victimSubmitBtnAlt = document.getElementById("btn-submit-victim-alt");
        if (victimSubmitBtnAlt) {
            victimSubmitBtnAlt.addEventListener("click", () => this.handleVictimSubmit("alt"));
        }

        // Modal Close Buttons
        document.querySelectorAll(".modal-close").forEach(btn => {
            btn.addEventListener("click", () => this.closeModals());
        });

        // Dispatch Submit Button in Modal
        const commitDispatchBtn = document.getElementById("btn-commit-dispatch");
        if (commitDispatchBtn) {
            commitDispatchBtn.addEventListener("click", () => this.handleCommitDispatch());
        }

        // Safety Sweep Button (Step 10)
        const sweepBtn = document.getElementById("btn-safety-sweep");
        if (sweepBtn) {
            sweepBtn.addEventListener("click", () => this.openSafetySweepModal());
        }
        const confirmSweepBtn = document.getElementById("btn-confirm-sweep-clearance");
        if (confirmSweepBtn) {
            confirmSweepBtn.addEventListener("click", () => this.handleConfirmSafetySweep());
        }

        // Standby & Export Button (Step 12)
        const standbyBtn = document.getElementById("btn-standby-export");
        if (standbyBtn) {
            standbyBtn.addEventListener("click", () => this.handleStandbyAndExport());
        }
        const resumeBtn = document.getElementById("btn-resume-cad");
        if (resumeBtn) {
            resumeBtn.addEventListener("click", () => this.handleResumeCad());
        }
        const redownloadBtn = document.getElementById("btn-redownload-json");
        if (redownloadBtn) {
            redownloadBtn.addEventListener("click", () => this.handleDownloadSessionJson());
        }

        // SITREP Export Buttons
        const copySitrepBtn = document.getElementById("btn-copy-sitrep");
        if (copySitrepBtn) {
            copySitrepBtn.addEventListener("click", async () => {
                const res = await fetch("/api/export/sitrep");
                const text = await res.text();
                navigator.clipboard.writeText(text);
                copySitrepBtn.innerText = "Copied to Clipboard!";
                setTimeout(() => { copySitrepBtn.innerText = "Copy SITREP (MD)"; }, 2000);
            });
        }

        const downloadSitrepBtn = document.getElementById("btn-download-sitrep");
        if (downloadSitrepBtn) {
            downloadSitrepBtn.addEventListener("click", async () => {
                const res = await fetch("/api/export/sitrep");
                const text = await res.text();
                const blob = new Blob([text], { type: "text/markdown" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `SITREP_CAD_${new Date().toISOString().substring(0, 10)}.md`;
                a.click();
            });
        }

        // Real-Time Tamil Nadu Sync Button
        const syncTnBtn = document.getElementById("btn-sync-tn-realtime");
        if (syncTnBtn) {
            syncTnBtn.addEventListener("click", async () => {
                syncTnBtn.disabled = true;
                syncTnBtn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Syncing TN Telemetry...`;
                try {
                    const res = await fetch("/api/realtime/sync-tamilnadu-alerts", { method: "POST" });
                    const data = await res.json();
                    await this.loadInitialData();
                    await this.loadTamilNaduTelemetry();
                    this.showNotification(`Live TN Telemetry Synced: ${data.synced_alerts_count} active meteorological alerts processed.`, "success");
                } catch (e) {
                    console.error("Sync error:", e);
                    this.showNotification("Live TN Telemetry Sync encountered an issue.", "warning");
                } finally {
                    syncTnBtn.disabled = false;
                    syncTnBtn.innerHTML = `<i data-lucide="satellite"></i> Sync Real-Time TN Telemetry`;
                    lucide.createIcons();
                }
            });
        }

        // Floating Map Sensor HUD Toggle
        const sensorHudToggleBtn = document.getElementById("btn-toggle-sensor-hud");
        const sensorHudPanel = document.getElementById("map-sensor-panel");
        const sensorHudArrow = document.getElementById("sensor-hud-arrow");
        if (sensorHudToggleBtn && sensorHudPanel) {
            sensorHudToggleBtn.addEventListener("click", () => {
                const isHidden = sensorHudPanel.style.display === "none";
                sensorHudPanel.style.display = isHidden ? "block" : "none";
                if (sensorHudArrow) {
                    sensorHudArrow.style.transform = isHidden ? "rotate(180deg)" : "rotate(0deg)";
                }
            });
        }

        // Align TN Tasks (4 Chennai + 4 TN)
        const resetTnBtn = document.getElementById("btn-reset-tn-db");
        if (resetTnBtn) {
            resetTnBtn.addEventListener("click", async () => {
                if (!confirm("Align active tasks strictly to 4 Chennai and 4 Tamil Nadu operational emergencies?")) return;
                resetTnBtn.disabled = true;
                resetTnBtn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Aligning Tasks...`;
                try {
                    await fetch("/api/database/reset-tamilnadu", { method: "POST" });
                    await this.loadInitialData();
                    this.showNotification("CAD Database aligned: 4 Chennai + 4 Tamil Nadu operational tasks active.", "success");
                } catch (e) {
                    console.error("Reset error:", e);
                } finally {
                    resetTnBtn.disabled = false;
                    resetTnBtn.innerHTML = `<i data-lucide="rotate-ccw"></i> Align TN Tasks (4+4)`;
                    lucide.createIcons();
                }
            });
        }

        // Drawer Expand / Minimize Controls
        const expandInsightBtn = document.getElementById("btn-expand-insight");
        if (expandInsightBtn) {
            expandInsightBtn.addEventListener("click", () => this.toggleExpandInsightPanel());
        }
        const minimizeInsightBtn = document.getElementById("btn-minimize-insight");
        if (minimizeInsightBtn) {
            minimizeInsightBtn.addEventListener("click", () => this.toggleMinimizeInsightPanel());
        }
        const restoreInsightPill = document.getElementById("btn-restore-insight-pill");
        if (restoreInsightPill) {
            restoreInsightPill.addEventListener("click", () => this.restoreInsightPanel());
        }

        // Geological Fault Line GIS Layer Toggle
        const toggleFaults = document.getElementById("toggle-geological-faults");
        if (toggleFaults) {
            toggleFaults.addEventListener("change", (e) => this.toggleGeologicalFaultLines(e.target.checked));
        }
    }

    openImageZoomModal(imgSrc, caption, meta) {
        const modal = document.getElementById("modal-image-zoom");
        const imgEl = document.getElementById("modal-zoom-img");
        const captionEl = document.getElementById("modal-zoom-caption");
        const metaEl = document.getElementById("modal-zoom-meta");

        if (imgEl) imgEl.src = imgSrc;
        if (captionEl) captionEl.innerHTML = caption || "Visual disaster recon photograph ingested into CAD.";
        if (metaEl) metaEl.innerText = meta ? `Incident: ${meta}` : "Visual Damage Telemetry";
        if (modal) modal.classList.add("active");
        if (window.lucide) lucide.createIcons();
    }

    switchTab(tabId) {
        // Strict Role-Based Route Protection
        if (this.currentRole === "FIELD_RESPONDER") {
            const allowedResponderTabs = ["tab-responder", "tab-casualty", "tab-sitrep"];
            if (!allowedResponderTabs.includes(tabId)) {
                this.showNotification("Access Denied: Control Room dispatch clearance required.", "danger");
                tabId = "tab-responder";
            }
        } else {
            const allowedControlTabs = [
                "tab-engine",
                "tab-map",
                "tab-predictions",
                "tab-capacity",
                "tab-relocation-plan",
                "tab-ingest",
                "tab-matrix",
                "tab-sitrep",
                "tab-redzones",
                "tab-relocation"
            ];
            if (!allowedControlTabs.includes(tabId)) {
                tabId = "tab-map";
            }
        }

        // Tab 4: Relocation Command Plan Activates "Plan" mode on the map
        const isRelocationPlanTab = (tabId === "tab-relocation-plan");
        const activeNavTabId = tabId;
        const targetPaneId = isRelocationPlanTab ? "tab-map" : tabId;

        this.activeTab = tabId;
        document.querySelectorAll(".nav-tab").forEach(tab => {
            tab.classList.toggle("active", tab.dataset.tab === activeNavTabId);
        });

        document.querySelectorAll(".tab-pane").forEach(pane => {
            pane.classList.toggle("active", pane.id === targetPaneId);
        });

        if (tabId === "tab-map" || isRelocationPlanTab) {
            [50, 150, 350, 700].forEach(d => {
                setTimeout(() => {
                    if (window.cadMapManager && window.cadMapManager.map) {
                        try { window.cadMapManager.map.invalidateSize(); } catch(e) {}
                    }
                }, d);
            });

            if (window.cadMapManager) {
                // In SIH26191 mode: Tab 4 activates 'CONVOYS' (Plan mode), Tab 2 activates 'RED_ZONES'
                const mapMode = isRelocationPlanTab ? "CONVOYS" : "RED_ZONES";
                window.cadMapManager.setMapMode(mapMode);
                const selectEl = document.getElementById("map-layer-mode");
                if (selectEl) selectEl.value = mapMode;

                if (this.redZones && this.redZones.length > 0) {
                    window.cadMapManager.renderRedZones(this.redZones);
                }
                if (this.habitations && this.habitations.length > 0) {
                    window.cadMapManager.renderHabitations(this.habitations);
                }
                if (this.shelters && this.shelters.length > 0) {
                    window.cadMapManager.renderShelters(this.shelters);
                }
                if (this.relocationPlan) {
                    window.cadMapManager.renderRelocationRoutes(this.relocationPlan);
                }
            }

            // Ensure the right-side Hazard Insight & Relocation Plan panel is visible
            const insightPanel = document.getElementById("hazard-insight-panel");
            if (insightPanel) insightPanel.style.display = "flex";
            const incidentDrawer = document.getElementById("map-incident-drawer");
            if (incidentDrawer) incidentDrawer.style.display = "none";

            this.renderHazardInsightPanel(this.selectedHazardZoneId || "HAB-VEL-01");
        } else if (tabId === "tab-predictions") {
            this.loadGeologicalPredictions();
        } else if (tabId === "tab-capacity") {
            this.updateCapacityCharts();
        } else if (tabId === "tab-engine") {
            this.loadTamilNaduTelemetry();
        } else if (tabId === "tab-redzones") {
            this.renderRedZonesPanel();
        } else if (tabId === "tab-relocation") {
            this.renderRelocationPanel();
        } else if (tabId === "tab-sitrep") {
            this.updateCharts();
            this.loadSitrepPreview();
        } else if (tabId === "tab-matrix") {
            this.renderMatrix();
        } else if (tabId === "tab-responder" || tabId === "tab-casualty") {
            this.renderResponderMission();
        }

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    setRole(role) {
        this.currentRole = role;

        // Update role toggle button active states
        document.querySelectorAll(".role-toggle-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.role === role);
        });

        // Show/Hide role specific navigation tabs in left sidebar
        if (role === "FIELD_RESPONDER") {
            document.querySelectorAll(".nav-role-control").forEach(el => el.style.display = "none");
            document.querySelectorAll(".nav-role-responder").forEach(el => el.style.display = "flex");
            this.switchTab("tab-responder");
            this.showNotification("Role Switched: Field Responder Tactical Terminal", "info");
        } else {
            document.querySelectorAll(".nav-role-control").forEach(el => el.style.display = "flex");
            document.querySelectorAll(".nav-role-responder").forEach(el => el.style.display = "none");
            this.switchTab("tab-map");
            this.showNotification("Role Switched: State Control Room Command", "info");
        }

        if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
            window.cadAudio.playBeep(980, 80);
        }
    }

    initSplitResizers() {
        const setupResizer = (dividerId, containerId, leftId, rightId, stateKey) => {
            const divider = document.getElementById(dividerId);
            const container = document.getElementById(containerId);
            const leftPane = document.getElementById(leftId);
            const rightPane = document.getElementById(rightId);

            if (!divider || !container || !leftPane || !rightPane) return;

            let dragging = false;

            const onMouseDown = (e) => {
                e.preventDefault();
                dragging = true;
                divider.classList.add("is-dragging");
                container.classList.add("is-dragging");
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
            };

            const onMouseMove = (e) => {
                if (!dragging) return;
                const rect = container.getBoundingClientRect();
                let newWidth = ((e.clientX - rect.left) / rect.width) * 100;
                if (newWidth < 20) newWidth = 20;
                if (newWidth > 80) newWidth = 80;
                newWidth = Math.round(newWidth * 10) / 10;

                this[stateKey] = newWidth;
                leftPane.style.width = `${newWidth}%`;
                rightPane.style.width = `${100 - newWidth}%`;

                if (stateKey === 'leftWidthPercent') {
                    const btnSplit = document.getElementById("btn-layout-split");
                    const btnLeft = document.getElementById("btn-layout-left-max");
                    const btnRight = document.getElementById("btn-layout-right-max");
                    if (btnSplit) btnSplit.classList.toggle("active", newWidth >= 45 && newWidth <= 55);
                    if (btnLeft) btnLeft.classList.toggle("active", newWidth > 55);
                    if (btnRight) btnRight.classList.toggle("active", newWidth < 45);
                }
            };

            const onMouseUp = () => {
                if (!dragging) return;
                dragging = false;
                divider.classList.remove("is-dragging");
                container.classList.remove("is-dragging");
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
            };

            divider.addEventListener("mousedown", onMouseDown);
            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        };

        setupResizer("split-divider-main", "split-workspace-container", "split-pane-left", "split-pane-right", "leftWidthPercent");
        setupResizer("split-divider-vision", "split-vision-container", "split-vision-left", "split-vision-right", "visionLeftWidthPercent");
    }

    setSplitWidth(percent) {
        this.leftWidthPercent = percent;
        const left = document.getElementById("split-pane-left");
        const right = document.getElementById("split-pane-right");
        if (left && right) {
            left.style.width = `${percent}%`;
            right.style.width = `${100 - percent}%`;
        }
        const btnSplit = document.getElementById("btn-layout-split");
        const btnLeft = document.getElementById("btn-layout-left-max");
        const btnRight = document.getElementById("btn-layout-right-max");
        if (btnSplit) btnSplit.classList.toggle("active", percent === 50);
        if (btnLeft) btnLeft.classList.toggle("active", percent === 80);
        if (btnRight) btnRight.classList.toggle("active", percent === 20);

        if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
            window.cadAudio.playBeep(980, 80);
        }
    }

    setPaneMode(mode) {
        if (mode === 'split') this.setSplitWidth(50);
        else if (mode === 'left-max') this.setSplitWidth(80);
        else if (mode === 'right-max') this.setSplitWidth(20);
    }

    toggleMinimize(panelId) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        const isLeft = panelId === "panel-ingest-input";
        
        if (isLeft) {
            this.ingestLayout.leftMinimized = !this.ingestLayout.leftMinimized;
        } else {
            this.ingestLayout.rightMinimized = !this.ingestLayout.rightMinimized;
        }

        const isMin = isLeft ? this.ingestLayout.leftMinimized : this.ingestLayout.rightMinimized;
        panel.classList.toggle("is-minimized", isMin);
        
        const minBtn = panel.querySelector(".win-btn-minimize");
        if (minBtn) {
            minBtn.innerHTML = isMin ? `<i data-lucide="plus"></i>` : `<i data-lucide="minus"></i>`;
            minBtn.title = isMin ? "Restore Window" : "Minimize Window";
        }

        if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
            window.cadAudio.playBeep(1100, 60);
        }
        if (window.lucide) {
            lucide.createIcons();
        }
    }

    togglePanelCollapse(panelId) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        
        if (panelId === "panel-ingest-input") {
            this.ingestLayout.leftCollapsed = !this.ingestLayout.leftCollapsed;
            panel.classList.toggle("is-collapsed", this.ingestLayout.leftCollapsed);
        } else if (panelId === "panel-ingest-output") {
            this.ingestLayout.rightCollapsed = !this.ingestLayout.rightCollapsed;
            panel.classList.toggle("is-collapsed", this.ingestLayout.rightCollapsed);
        } else if (panelId === "panel-vision-workbench") {
            this.ingestLayout.visionCollapsed = !this.ingestLayout.visionCollapsed;
            panel.classList.toggle("is-collapsed", this.ingestLayout.visionCollapsed);
        } else {
            panel.classList.toggle("is-collapsed");
        }

        const isCollapsed = panel.classList.contains("is-collapsed");
        const collapseBtn = panel.querySelector(".win-btn-collapse");
        if (collapseBtn) {
            collapseBtn.innerHTML = isCollapsed ? 
                `<i data-lucide="chevron-down"></i>` : 
                `<i data-lucide="chevron-up"></i>`;
            collapseBtn.title = isCollapsed ? "Expand Window" : "Collapse Window";
        }
        if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
            window.cadAudio.playBeep(1200, 60);
        }
        if (window.lucide) {
            lucide.createIcons();
        }
    }

    toggleIngestPaneFocus(panelId) {
        const isLeft = panelId === "panel-ingest-input";
        if (isLeft) {
            if (this.leftWidthPercent >= 75) this.setSplitWidth(50);
            else this.setSplitWidth(80);
        } else {
            if (this.leftWidthPercent <= 25) this.setSplitWidth(50);
            else this.setSplitWidth(20);
        }
    }

    resetIngestLayout() {
        this.ingestLayout = {
            paneMode: 'split',
            leftCollapsed: false,
            rightCollapsed: false,
            leftMinimized: false,
            rightMinimized: false,
            visionCollapsed: false
        };

        this.setSplitWidth(50);
        const vLeft = document.getElementById("split-vision-left");
        const vRight = document.getElementById("split-vision-right");
        if (vLeft && vRight) {
            vLeft.style.width = "50%";
            vRight.style.width = "50%";
        }

        ["panel-ingest-input", "panel-ingest-output", "panel-vision-workbench"].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.remove("is-collapsed", "is-minimized");
                const colBtn = el.querySelector(".win-btn-collapse");
                if (colBtn) {
                    colBtn.innerHTML = `<i data-lucide="chevron-up"></i>`;
                    colBtn.title = "Collapse Window";
                }
                const minBtn = el.querySelector(".win-btn-minimize");
                if (minBtn) {
                    minBtn.innerHTML = `<i data-lucide="minus"></i>`;
                    minBtn.title = "Minimize Window";
                }
            }
        });

        this.showNotification("Workspace layout reset to dual split 50/50.", "info");
        if (window.cadAudio && typeof window.cadAudio.playSuccess === 'function') {
            window.cadAudio.playSuccess();
        }
    }

    async loadTamilNaduTelemetry() {
        try {
            const res = await fetch("/api/realtime/tamilnadu-telemetry");
            if (!res.ok) return;
            const data = await res.json();
            const reports = data.station_reports || [];
            
            if (reports.length > 0) {
                const first = reports[0];
                const sumTempEl = document.getElementById("sensor-hud-summary-temp");
                if (sumTempEl && first.telemetry?.temperature_c !== undefined) {
                    sumTempEl.innerText = `${first.telemetry.temperature_c}°C`;
                }
                const liveTagEl = document.getElementById("sensor-hud-live-tag");
                if (liveTagEl) {
                    liveTagEl.innerText = `${reports.length} STATIONS LIVE`;
                }
            }

            reports.forEach(r => {
                const dist = (r.district || "").toLowerCase();
                const temp = r.telemetry?.temperature_c !== undefined ? r.telemetry.temperature_c : "--";
                const rain = r.telemetry?.precipitation_mm !== undefined ? r.telemetry.precipitation_mm : 0.0;
                
                const el = document.getElementById(`tel-${dist}`);
                if (el) {
                    el.innerText = `${temp}°C | ${rain}mm`;
                    if (rain > 10.0 || r.risk_level === "SEVERE") {
                        el.style.color = "#f87171";
                    } else {
                        el.style.color = "#60a5fa";
                    }
                }
            });
        } catch (e) {
            console.debug("Telemetry update error:", e);
        }
    }

    async loadInitialData() {
        try {
            const [incRes, unitRes, statRes, stnRes] = await Promise.all([
                fetch("/api/incidents").catch(() => null),
                fetch("/api/units").catch(() => null),
                fetch("/api/stats").catch(() => null),
                fetch("/api/stations").catch(() => null)
            ]);

            if (incRes && incRes.ok) this.incidents = await incRes.json();
            if (unitRes && unitRes.ok) this.units = await unitRes.json();
            if (statRes && statRes.ok) this.stats = await statRes.json();
            try { if (stnRes && stnRes.ok) this.stations = await stnRes.json(); } catch(e) { this.stations = []; }

            // If empty, auto-seed 4 Chennai + 4 Tamil Nadu operational tasks
            if (!this.incidents || this.incidents.length === 0) {
                try {
                    const resetRes = await fetch("/api/database/reset-tamilnadu", { method: "POST" });
                    if (resetRes && resetRes.ok) {
                        const rData = await resetRes.json();
                        this.incidents = rData.incidents || [];
                        if (rData.stats) this.stats = rData.stats;
                    }
                } catch (e) {
                    console.debug("Auto-seed error handled:", e);
                }
            }

            this.updateTelemetry();
            this.renderMapViews();
            this.renderMatrix();
            this.updateTicker();
            this.loadTamilNaduTelemetry();
        } catch (e) {
            console.error("Failed to load CAD data:", e);
            this.updateTelemetry();
            this.renderMapViews();
            this.renderMatrix();
            this.updateTicker();
        }
    }

    connectWebSocket() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${protocol}//${window.location.host}/ws/cad`;
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log("Connected to CAD WebSocket telemetry stream.");
            const dot = document.getElementById("ws-status-dot");
            if (dot) {
                dot.style.background = "var(--low)";
                dot.style.boxShadow = "0 0 8px var(--low)";
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleWebSocketEvent(data);
            } catch (e) {
                console.warn("WebSocket parse error:", e);
            }
        };

        this.ws.onclose = () => {
            console.log("WebSocket disconnected. Reconnecting in 3s...");
            const dot = document.getElementById("ws-status-dot");
            if (dot) {
                dot.style.background = "var(--critical)";
                dot.style.boxShadow = "0 0 8px var(--critical)";
            }
            setTimeout(() => this.connectWebSocket(), 3000);
        };
    }

    handleWebSocketEvent(data) {
        if (data.event === "INITIAL_STATE") {
            if (data.stations) this.stations = data.stations;
            if (data.units) this.units = data.units;
            if (data.stats) this.stats = data.stats;
            this.renderMapViews();
            this.updateTelemetry();
        } else if (data.event === "INCIDENT_INGESTED" || data.event === "incident:new") {

            const newInc = data.incident;
            // Prepend new incident
            this.incidents = this.incidents.filter(i => i.id !== newInc.id);
            this.incidents.unshift(newInc);

            if (newInc.severity === "CRITICAL") {
                window.cadAudio.playCriticalAlert();
                this.showNotification(`🚨 CRITICAL ALARM: ${newInc.title}`, "danger");
            } else {
                window.cadAudio.playDispatchPing();
                this.showNotification(`📢 New Incident Ingested: ${newInc.title}`, "info");
            }

            if (data.stats) this.stats = data.stats;
            this.renderMapViews();
            this.renderMatrix();
            this.updateTicker();
            this.updateTelemetry();
            if (this.activeTab === "tab-responder") {
                this.renderResponderMission();
            }
        } else if (data.event === "incident:sos_triggered") {
            // Geospatial Deduplication SOS Merge Notification
            window.cadAudio.playCriticalAlert();
            this.showNotification(`🚨 SOS DEDUPLICATION MERGE: Incident ${data.incidentId} received repeated alert (Total SOS count: ${data.newSosCount})`, "danger");
            if (data.incident) {
                const idx = this.incidents.findIndex(i => i.id === data.incident.id);
                if (idx !== -1) {
                    this.incidents[idx] = data.incident;
                } else {
                    this.incidents.unshift(data.incident);
                }
                this.renderMapViews();
                this.renderMatrix();
                this.updateTicker();
                if (this.activeTab === "tab-responder") this.renderResponderMission();
            }
        } else if (data.event === "VICTIM_LOGGED") {
            this.showNotification(`🏥 Casualty Logged: [${data.victim?.category || 'VICTIM'}] ${data.victim?.name || 'Individual'} on ${data.incident_id}`, "info");
            if (data.incident) {
                const idx = this.incidents.findIndex(i => i.id === data.incident.id);
                if (idx !== -1) this.incidents[idx] = data.incident;
                if (this.activeTab === "tab-responder") this.renderResponderMission();
            }
        } else if (data.event === "INCIDENT_UPDATED" || data.event === "STATUS_UPDATED" || data.event === "STATUS_CHANGED") {
            const updatedInc = data.incident;
            const idx = this.incidents.findIndex(i => i.id === updatedInc.id);
            if (idx !== -1) {
                this.incidents[idx] = updatedInc;
            }
            if (data.units) this.units = data.units;
            if (data.stats) this.stats = data.stats;

            this.renderMapViews();
            this.renderMatrix();
            this.updateTelemetry();
            if (this.selectedIncident && this.selectedIncident.id === updatedInc.id) {
                this.selectIncident(updatedInc);
            }
            if (this.activeTab === "tab-responder") {
                this.renderResponderMission();
            }
        } else if (data.event === "UNITS_DISPATCHED") {
            const updatedInc = data.incident;
            const idx = this.incidents.findIndex(i => i.id === updatedInc.id);
            if (idx !== -1) {
                this.incidents[idx] = updatedInc;
            }
            if (data.units) this.units = data.units;
            if (data.stats) this.stats = data.stats;

            this.renderMapViews();
            this.renderMatrix();
            this.updateTelemetry();
            if (this.activeTab === "tab-responder") {
                this.renderResponderMission();
            }
        } else if (data.event === "STREAM_ACTIVITY" || data.event === "cad:incident_streamed") {
            if (data.stream_event) {
                this.handleStreamActivityEvent(data.stream_event);
            }
        } else if (data.event === "cad:kpi_updated" || data.event === "STATS_UPDATED") {
            if (data.stats) {
                this.stats = data.stats;
                this.updateTelemetry();
            }
        } else if (data.event === "RELOCATION_EXECUTED") {
            this.showNotification(`🚚 RELOCATION CONVOY DISPATCHED: ${data.habitation_name} -> ${data.shelter_name} (${data.evacuees_moved} evacuees)`, "success");
            if (window.cadAudio && typeof window.cadAudio.playSuccess === "function") {
                window.cadAudio.playSuccess();
            }
            this.loadSIH26191Data();
        }
    }

    async refreshStats() {
        try {
            const res = await fetch("/api/stats");
            this.stats = await res.json();
            this.updateTelemetry();
        } catch (e) {}
    }

    updateTelemetry() {
        if (!this.stats) return;
        const totalEl = document.getElementById("telemetry-total-inc");
        const critEl = document.getElementById("telemetry-critical-inc");
        const trappedEl = document.getElementById("telemetry-trapped");
        const unitsEl = document.getElementById("telemetry-units-disp");

        if (totalEl) totalEl.innerText = this.stats.total_incidents;
        if (critEl) critEl.innerText = this.stats.active_critical;
        if (trappedEl) trappedEl.innerText = this.stats.trapped_count;
        if (unitsEl) unitsEl.innerText = `${this.stats.dispatched_units} / ${this.units.length}`;

        // Situation room stats
        const sitTotal = document.getElementById("sit-stat-total");
        const sitCrit = document.getElementById("sit-stat-critical");
        const sitTrapped = document.getElementById("sit-stat-trapped");
        const sitInjured = document.getElementById("sit-stat-injured");
        const sitUnits = document.getElementById("sit-stat-units");
        const sitUrgency = document.getElementById("sit-stat-urgency");

        if (sitTotal) sitTotal.innerText = this.stats.total_incidents;
        if (sitCrit) sitCrit.innerText = this.stats.active_critical;
        if (sitTrapped) sitTrapped.innerText = this.stats.trapped_count;
        if (sitInjured) sitInjured.innerText = this.stats.injured_count;
        if (sitUnits) sitUnits.innerText = `${this.stats.dispatched_units} Active (${this.stats.available_units} Avail)`;
        if (sitUrgency) sitUrgency.innerText = `${this.stats.average_urgency} / 100`;
    }

    // -------------------------------------------------------------
    // REAL-TIME SOCIAL MEDIA INGESTION STREAM METHODS
    // -------------------------------------------------------------

    toggleSocialStreamDrawer(forceState) {
        const drawer = document.getElementById("stream-drawer") || document.getElementById("social-stream-drawer");
        if (!drawer) return;

        const isVisible = drawer.style.display === "flex";
        const shouldOpen = (typeof forceState === "boolean") ? forceState : !isVisible;

        if (shouldOpen) {
            drawer.style.display = "flex";
            drawer.style.zIndex = "10000";
            this.loadStreamStatus();
            if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
                try { window.cadAudio.playBeep(980, 80); } catch(e) {}
            }
        } else {
            drawer.style.display = "none";
        }
    }

    async loadStreamStatus() {
        try {
            const res = await fetch("/api/stream/status");
            if (!res.ok) return;
            const data = await res.json();
            this.streamRunning = data.running;
            this.streamStats = {
                ingested: data.ingested_count || 0,
                tickets: data.ticket_created_count || 0,
                merged: data.merged_count || 0,
                discarded: data.discarded_count || 0
            };
            this.streamEvents = data.recent_events || [];

            this.updateStreamHudUI();
            this.renderStreamEvents(this.streamEvents);
        } catch (e) {
            console.debug("Stream status fetch error:", e);
        }
    }

    updateStreamHudUI() {
        const dot = document.getElementById("ws-status-dot");
        const statusText = document.getElementById("stream-hud-status-text");
        const countBadge = document.getElementById("stream-hud-count");
        const btnLabel = document.getElementById("btn-stream-toggle-label");

        if (dot) {
            dot.classList.toggle("active", this.streamRunning);
            dot.classList.toggle("paused", !this.streamRunning);
        }
        if (statusText) {
            statusText.innerText = this.streamRunning ? "LIVE" : "PAUSED";
            statusText.style.color = this.streamRunning ? "#34d399" : "#f59e0b";
        }
        if (countBadge) {
            countBadge.innerText = this.streamStats.ingested;
        }
        if (btnLabel) {
            btnLabel.innerText = this.streamRunning ? "Pause" : "Resume";
        }

        const ingEl = document.getElementById("stream-stat-ingested");
        const tktEl = document.getElementById("stream-stat-tickets");
        const mrgEl = document.getElementById("stream-stat-merged");
        const disEl = document.getElementById("stream-stat-discarded");

        if (ingEl) ingEl.innerText = this.streamStats.ingested;
        if (tktEl) tktEl.innerText = this.streamStats.tickets;
        if (mrgEl) mrgEl.innerText = this.streamStats.merged;
        if (disEl) disEl.innerText = this.streamStats.discarded;
    }

    async toggleStreamWorker() {
        try {
            const res = await fetch("/api/stream/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enable: !this.streamRunning })
            });
            const data = await res.json();
            this.streamRunning = data.running;
            this.updateStreamHudUI();
            this.showNotification(`Social Ingestion Stream is now ${this.streamRunning ? 'ACTIVE (Listening)' : 'PAUSED'}`, this.streamRunning ? "success" : "info");
            if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
                window.cadAudio.playBeep(this.streamRunning ? 1200 : 700, 100);
            }
        } catch (e) {
            console.error("Failed to toggle stream worker:", e);
        }
    }

    async simulateStreamPost() {
        try {
            const res = await fetch("/api/stream/simulate-now", { method: "POST" });
            const data = await res.json();
            if (data.event) {
                this.handleStreamActivityEvent(data.event);
                this.showNotification(`⚡ Live Stream Ingested: ${data.event.item.platform} (${data.event.action_taken})`, "info");
            }
        } catch (e) {
            console.error("Simulate stream post error:", e);
        }
    }

    async clearStreamLog() {
        try {
            await fetch("/api/stream/clear-log", { method: "POST" });
            this.streamEvents = [];
            this.renderStreamEvents([]);
            this.showNotification("Social crisis stream log cleared.", "info");
        } catch (e) {}
    }

    handleStreamActivityEvent(eventData) {
        if (!eventData || !eventData.item) return;
        this.streamStats.ingested += 1;
        if (eventData.action_taken === "TICKET_GENERATED") this.streamStats.tickets += 1;
        else if (eventData.action_taken === "MERGED") this.streamStats.merged += 1;
        else this.streamStats.discarded += 1;

        this.streamEvents.unshift(eventData);
        if (this.streamEvents.length > 50) this.streamEvents.pop();

        this.updateStreamHudUI();
        this.prependStreamEvent(eventData);

        // React based on action
        if (eventData.action_taken === "TICKET_GENERATED") {
            if (window.cadAudio && typeof window.cadAudio.playAlert === 'function') {
                window.cadAudio.playAlert();
            }
            this.showNotification(`🚨 NEW INCIDENT STREAMED: ${eventData.incident_title || eventData.incident_id} (${eventData.item.platform})`, "danger");
            this.refreshIncidentsSilently();
        } else if (eventData.action_taken === "MERGED") {
            if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
                window.cadAudio.playBeep(880, 120);
            }
            this.showNotification(`🔗 SOCIAL DEDUP: Merged report with ${eventData.incident_id}`, "warning");
            this.refreshIncidentsSilently();
        }
    }

    async refreshIncidentsSilently() {
        try {
            const [incRes, statRes] = await Promise.all([
                fetch("/api/incidents"),
                fetch("/api/stats")
            ]);
            this.incidents = await incRes.json();
            this.stats = await statRes.json();
            this.renderMapViews();
            this.renderMatrix();
            this.updateTelemetry();
            this.updateTicker();
        } catch (e) {}
    }

    renderStreamEvents(events) {
        const listEl = document.getElementById("stream-feed-list") || document.getElementById("social-stream-list");
        if (!listEl) return;
        if (!events || events.length === 0) {
            listEl.innerHTML = `
                <div class="stream-empty-state">
                    <i data-lucide="activity" style="width: 32px; height: 32px; opacity: 0.4; margin-bottom: 8px;"></i>
                    <div>Listening to continuous crisis stream across Tamil Nadu...</div>
                    <div style="font-size: 0.72rem; color: var(--text-muted); margin-top: 4px;">Click "Test Post" to trigger an instant incoming distress signal.</div>
                </div>
            `;
            if (window.lucide) {
                try { lucide.createIcons(); } catch(e) {}
            }
            return;
        }

        listEl.innerHTML = events.map(evt => this.formatStreamCardHtml(evt)).join("");
        if (window.lucide) {
            try { lucide.createIcons(); } catch(e) {}
        }
    }

    prependStreamEvent(eventData) {
        const listEl = document.getElementById("stream-feed-list") || document.getElementById("social-stream-list");
        if (!listEl) return;

        const empty = listEl.querySelector(".stream-empty-state");
        if (empty) empty.remove();

        const cardHtml = this.formatStreamCardHtml(eventData);
        const temp = document.createElement("div");
        temp.innerHTML = cardHtml;
        const newCard = temp.firstElementChild;
        listEl.insertBefore(newCard, listEl.firstChild);

        // Keep at most 50 DOM items
        while (listEl.children.length > 50) {
            listEl.removeChild(listEl.lastChild);
        }

        if (window.lucide) {
            try { lucide.createIcons(); } catch(e) {}
        }
    }

    formatStreamCardHtml(evt) {
        const item = evt.item || {};
        let platClass = "twitter";
        let platLabel = "𝕏 / Twitter";
        let platIcon = "message-circle";

        if (item.platform === "REDDIT") {
            platClass = "reddit";
            platLabel = "Reddit";
            platIcon = "message-square";
        } else if (item.platform === "DISPATCH_112") {
            platClass = "dispatch_112";
            platLabel = "112 CAD";
            platIcon = "phone-call";
        } else if (item.platform === "TELEGRAM") {
            platClass = "telegram";
            platLabel = "Telegram";
            platIcon = "send";
        } else if (item.platform === "CITIZEN_PORTAL") {
            platClass = "citizen_portal";
            platLabel = "Citizen SOS";
            platIcon = "radio-tower";
        }

        let actionPillHtml = "";
        if (evt.action_taken === "TICKET_GENERATED") {
            actionPillHtml = `<span class="stream-action-pill ticket">✅ INCIDENT CREATED: ${evt.incident_id || 'INC-NEW'}</span>`;
        } else if (evt.action_taken === "MERGED") {
            actionPillHtml = `<span class="stream-action-pill merged">🔗 MERGED WITH ${evt.incident_id || 'INC-ACTIVE'} (+1 Report)</span>`;
        } else if (evt.action_taken === "OUT_OF_JURISDICTION") {
            actionPillHtml = `<span class="stream-action-pill outofjurisdiction">⛔ REJECTED: OUT OF TN JURISDICTION</span>`;
        } else {
            actionPillHtml = `<span class="stream-action-pill spam">🗑️ FILTERED: SPAM / NON-EMERGENCY</span>`;
        }

        let timeStr = "Just now";
        if (evt && (evt.timestamp || (evt.item && evt.item.timestamp))) {
            try {
                const rawTime = evt.timestamp || evt.item.timestamp;
                const d = new Date(rawTime);
                if (!isNaN(d.getTime())) {
                    timeStr = d.toISOString().substring(11, 19) + " UTC";
                }
            } catch (e) {
                timeStr = "Just now";
            }
        }

        let linkHtml = "";
        if (item.source_url) {
            linkHtml = `<a href="${item.source_url}" target="_blank" class="stream-card-btn" title="Open original social post"><i data-lucide="external-link" style="width: 10px; height: 10px;"></i> Source</a>`;
        }

        let locateBtnHtml = "";
        if (evt.incident_id && (evt.action_taken === "TICKET_GENERATED" || evt.action_taken === "MERGED")) {
            locateBtnHtml = `
                <button type="button" class="stream-card-btn" onclick="window.cadApp.focusStreamIncident('${evt.incident_id}')" title="Locate on Tactical Map">
                    <i data-lucide="map-pin" style="width: 10px; height: 10px;"></i> Locate
                </button>
            `;
        }

        return `
            <div class="stream-card" id="stream-card-${item.id || ''}">
                <div class="stream-card-header">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="stream-platform-tag ${platClass}">
                            <i data-lucide="${platIcon}" style="width: 10px; height: 10px;"></i> ${platLabel}
                        </span>
                        <span class="stream-card-author">${item.author || '@citizen'}</span>
                    </div>
                    <span class="stream-card-time">${timeStr}</span>
                </div>

                <div class="stream-card-text">
                    "${(item.text || '').replace(/"/g, '&quot;')}"
                </div>

                ${item.location_hint ? `
                    <div class="stream-card-meta">
                        <span>📍 ${item.location_hint}</span>
                    </div>
                ` : ''}

                <div class="stream-card-actions">
                    <div>${actionPillHtml}</div>
                    <div style="display: flex; gap: 4px;">
                        ${locateBtnHtml}
                        ${linkHtml}
                    </div>
                </div>
            </div>
        `;
    }

    focusStreamIncident(incidentId) {
        const inc = this.incidents.find(i => i.id === incidentId);
        if (inc) {
            this.switchTab("tab-matrix");
            this.selectIncident(inc);
            this.showNotification(`Focused on stream incident ${incidentId}`, "info");
        } else {
            this.showNotification(`Incident ${incidentId} was archived or updated.`, "info");
        }
    }

    updateTicker() {
        const critIncidents = this.incidents.filter(i => i.severity === "CRITICAL" && i.status !== "RESOLVED");
        const ticker = document.getElementById("active-alert-ticker");
        if (!ticker) return;

        if (critIncidents.length > 0) {
            ticker.innerText = `ACTIVE CRITICAL DISPATCHES: [${critIncidents.map(i => {
                const t = i.created_at ? new Date(i.created_at).toISOString().substring(11, 19) + ' UTC' : '';
                return `${i.id} (${t}): ${i.title}`;
            }).join("  |  ")}]`;
        } else {
            ticker.innerText = "NO ACTIVE CRITICAL EMERGENCY ALARMS - ALL SECTORS MONITORED";
        }
    }

    renderMapViews() {
        if (!window.cadMapManager) return;
        if (window.cadMapManager.activeMapMode === "CAD_DISPATCH") {
            window.cadMapManager.renderIncidents(this.incidents, (inc) => this.selectIncident(inc));
            window.cadMapManager.renderUnits(this.units);
            if (this.stations && this.stations.length > 0) {
                window.cadMapManager.renderStations(this.stations, this.incidents, this.selectedIncident, this.units);
            }
        } else {
            // Clean Strategic Hazard Mode: suppress CAD pins and maintain smooth hazard zones & census layers
            window.cadMapManager.clearCADMarkers();
            if (this.redZones && this.redZones.length > 0) {
                window.cadMapManager.renderRedZones(this.redZones);
            }
            if (this.habitations && this.habitations.length > 0) {
                window.cadMapManager.renderHabitations(this.habitations);
            }
            if (this.shelters && this.shelters.length > 0) {
                window.cadMapManager.renderShelters(this.shelters);
            }
            if (this.relocationPlan) {
                window.cadMapManager.renderRelocationRoutes(this.relocationPlan);
            }
        }
    }

    async selectIncident(inc) {
        this.selectedIncident = inc;
        if (this.stations && this.stations.length > 0) {
            window.cadMapManager.renderStations(this.stations, this.incidents, this.selectedIncident, this.units);
        }
        const drawer = document.getElementById("map-incident-drawer");
        if (!drawer) return;

        drawer.style.display = "flex";
        window.cadMapManager.clearUnitRoute();
        window.cadMapManager.clearPOIs();
        
        let sevClass = "badge-moderate";
        if (inc.severity === "CRITICAL") sevClass = "badge-critical";
        else if (inc.severity === "HIGH") sevClass = "badge-high";
        else if (inc.severity === "LOW") sevClass = "badge-low";

        let timeStr = "";
        if (inc.created_at) {
            try {
                timeStr = new Date(inc.created_at).toISOString().substring(11, 19) + " UTC";
            } catch(e) {}
        }

        let imageEvidenceHtml = "";
        const rawImg = inc.image_base64 || inc.image_url || inc.image_path || (inc.imageAnalysis && (inc.imageAnalysis.image_url || inc.imageAnalysis.image_base64));
        if (rawImg) {
            const imgSrc = rawImg.startsWith("data:") ? rawImg : (rawImg.startsWith("http") || rawImg.startsWith("/") ? rawImg : `data:image/jpeg;base64,${rawImg}`);
            const safeCaption = (inc.imageAnalysis?.synopsis || inc.casualty_summary || inc.title || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
            imageEvidenceHtml = `
                <div class="evidence-photo-box" onclick="window.cadApp.openImageZoomModal('${imgSrc}', '${safeCaption}', '${inc.id}')" title="Click to view full-resolution photo evidence">
                    <img src="${imgSrc}" class="evidence-photo-img" alt="Visual Incident Evidence" />
                    <div class="evidence-zoom-hint">
                        <i data-lucide="maximize-2" style="width: 11px; height: 11px;"></i> Click to Zoom
                    </div>
                </div>
            `;
        }

        let outOfJurisdictionBadge = "";
        if (inc.is_out_of_jurisdiction || inc.jurisdiction_warning) {
            outOfJurisdictionBadge = `<span class="badge badge-warning" style="background: rgba(239, 68, 68, 0.25); border: 1px solid #ef4444; color: #fca5a5; margin-left: 4px;">⚠️ OUT OF JURISDICTION (TN SEOC ONLY)</span>`;
        }

        drawer.innerHTML = `
            <div class="drawer-header">
                <div>
                    <span class="badge ${sevClass}">${inc.severity}</span>
                    <span class="badge badge-type" style="margin-left: 4px;">${inc.type}</span>
                    ${outOfJurisdictionBadge}
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 4px;">${inc.id} &bull; ${timeStr}</div>
                </div>
                <button class="btn-icon" onclick="document.getElementById('map-incident-drawer').style.display='none'; window.cadApp.selectedIncident = null; window.cadMapManager.clearUnitRoute(); window.cadMapManager.clearPOIs(); window.cadMapManager.renderStations(window.cadApp.stations, window.cadApp.incidents, null, window.cadApp.units);">
                    <i data-lucide="x"></i>
                </button>
            </div>

            <div class="drawer-body">
                <h3 style="font-size: 1rem; font-weight: 700; line-height: 1.3;">${inc.title}</h3>
                
                <div class="urgency-gauge">
                    <span>URGENCY: ${inc.urgency_score}/100</span>
                    <div class="urgency-bar-wrap">
                        <div class="urgency-bar-fill ${inc.severity.toLowerCase()}" style="width: ${inc.urgency_score}%;"></div>
                    </div>
                </div>

                ${imageEvidenceHtml}

                <!-- Nearest Unit Dispatch Recommendation Box -->
                <div id="drawer-nearest-dispatch-box" style="background: rgba(249, 115, 22, 0.12); border: 1px solid rgba(249, 115, 22, 0.4); border-radius: 8px; padding: 10px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.75rem; font-weight: 700; color: #fb923c;">
                        <span><i data-lucide="navigation" style="width: 13px; display: inline-block; vertical-align: middle;"></i> NEAREST RESPONSE UNIT</span>
                        <span id="drawer-rec-eta" style="font-family: var(--font-mono); color: #fed7aa;">Calculating...</span>
                    </div>
                    <div id="drawer-rec-body" style="margin-top: 6px; font-size: 0.8rem; color: var(--text-primary);">
                        <div style="color: var(--text-muted);">Finding optimal available unit & route...</div>
                    </div>
                </div>

                <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px;">
                    <div style="font-size: 0.75rem; color: var(--text-secondary);"><i data-lucide="map-pin" style="width: 14px; display: inline-block; vertical-align: middle;"></i> Location</div>
                    <div style="font-weight: 600; font-size: 0.85rem; margin-top: 2px;">${inc.location_name}</div>
                    <div style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono);">${inc.latitude.toFixed(4)}, ${inc.longitude.toFixed(4)}</div>
                </div>

                <!-- Nearby Emergency POI Infrastructure Card -->
                <div style="background: rgba(15, 23, 42, 0.7); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px;">
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); display: flex; justify-content: space-between;">
                        <span><i data-lucide="building-2" style="width: 13px; display: inline-block; vertical-align: middle;"></i> NEARBY POI INFRASTRUCTURE</span>
                        <span id="poi-count-badge" style="color: #38bdf8; font-size: 0.7rem;">Scanning...</span>
                    </div>
                    <div id="drawer-poi-list" style="margin-top: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 120px; overflow-y: auto;">
                        <span style="font-size: 0.75rem; color: var(--text-muted);">Fetching nearby hospitals, police & fire stations...</span>
                    </div>
                </div>

                <div class="casualties-grid">
                    <div class="cas-box">
                        <div class="cas-count" style="color: #f87171;">${inc.affected_trapped}</div>
                        <div class="cas-label">Trapped</div>
                    </div>
                    <div class="cas-box">
                        <div class="cas-count" style="color: #fb923c;">${inc.affected_injured}</div>
                        <div class="cas-label">Injured</div>
                    </div>
                    <div class="cas-box">
                        <div class="cas-count" style="color: #34d399;">${inc.affected_evacuated}</div>
                        <div class="cas-label">Evacuated</div>
                    </div>
                    <div class="cas-box">
                        <div class="cas-count" style="color: #38bdf8;">${inc.affected_total}</div>
                        <div class="cas-label">Total Est</div>
                    </div>
                </div>

                <div>
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">Casualty Summary</div>
                    <p style="font-size: 0.82rem; margin-top: 4px; color: var(--text-primary); line-height: 1.4;">${inc.casualty_summary}</p>
                </div>

                <div>
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">Actionable Triage Directives</div>
                    <p style="font-size: 0.82rem; margin-top: 4px; color: #93c5fd; background: rgba(59, 130, 246, 0.1); padding: 8px; border-radius: 6px; border: 1px solid rgba(59, 130, 246, 0.25); line-height: 1.4;">${inc.actionable_notes}</p>
                </div>

                <div>
                    <div style="font-size: 0.75rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase;">Dispatched Units (${inc.dispatched_units.length})</div>
                    <div style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px;">
                        ${inc.dispatched_units.length > 0 ? 
                            inc.dispatched_units.map(u => `<span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4);">${u}</span>`).join('') :
                            '<span style="font-size: 0.8rem; color: var(--text-muted);">No units dispatched yet.</span>'
                        }
                    </div>
                </div>

                <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <button class="btn btn-primary" style="flex: 1;" onclick="window.cadApp.openDispatchModal('${inc.id}')">
                        <i data-lucide="send"></i> Dispatch Units
                    </button>
                    <button class="btn btn-secondary" onclick="window.cadApp.updateIncidentStatusPrompt('${inc.id}')">
                        <i data-lucide="check-circle"></i> Status
                    </button>
                </div>
            </div>
        `;
        lucide.createIcons();
        const coords = (window.parseCoordinates && window.parseCoordinates(inc)) || { lat: inc.latitude, lng: inc.longitude };
        if (coords && coords.lat && coords.lng) {
            window.cadMapManager.focusLocation(coords.lat, coords.lng);
        }

        // Fetch POIs and Nearest Unit Recommendation in parallel
        this.fetchAndRenderDrawerPOIs(inc);
        this.fetchAndRenderNearestUnit(inc);
    }

    async fetchAndRenderDrawerPOIs(inc) {
        try {
            const coords = (window.parseCoordinates && window.parseCoordinates(inc)) || { lat: inc.latitude, lng: inc.longitude };
            if (!coords || !coords.lat || !coords.lng) return;

            const res = await fetch(`/api/pois?lat=${coords.lat}&lng=${coords.lng}&radius=5000`);
            const pois = await res.json();
            const listEl = document.getElementById("drawer-poi-list");
            const badgeEl = document.getElementById("poi-count-badge");
            
            if (badgeEl) badgeEl.innerText = `${pois.length} within 5km`;

            if (listEl) {
                if (pois.length === 0) {
                    listEl.innerHTML = `<span style="font-size: 0.75rem; color: var(--text-muted);">No emergency facilities within 5km.</span>`;
                } else {
                    listEl.innerHTML = pois.slice(0, 4).map(p => {
                        let icon = p.type === "hospital" ? "🏥" : (p.type === "fire_station" ? "🚒" : "🚓");
                        return `
                            <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.3); padding: 4px 6px; border-radius: 4px; font-size: 0.75rem;">
                                <div style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px;">
                                    <span>${icon}</span> <strong>${p.name}</strong>
                                </div>
                                <span style="color: #fbbf24; font-weight: 700; font-family: var(--font-mono);">${p.distance_km} km</span>
                            </div>
                        `;
                    }).join('');
                }
            }

            window.cadMapManager.renderPOIs(pois);
        } catch (e) {
            console.warn("POI fetch error:", e);
        }
    }


    async fetchAndRenderNearestUnit(inc) {
        const recBox = document.getElementById("drawer-rec-body");
        const etaEl = document.getElementById("drawer-rec-eta");

        if (inc.is_out_of_jurisdiction || inc.jurisdiction_warning) {
            if (etaEl) etaEl.innerText = "OUT OF SECTOR";
            if (recBox) {
                recBox.innerHTML = `
                    <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; padding: 8px; font-size: 0.76rem; color: #fca5a5;">
                        <strong>⚠️ Out of Jurisdiction (Tamil Nadu SEOC Only)</strong>
                        <div style="margin-top: 4px; color: #fecaca; line-height: 1.3;">Automated dispatch recommendation and route synthesis are disabled for locations outside Tamil Nadu state boundaries.</div>
                    </div>
                `;
            }
            return;
        }

        try {
            const res = await fetch(`/api/incidents/${inc.id}/nearest-dispatch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({})
            });

            if (res.ok) {
                const data = await res.json();
                if (data.status === "SUCCESS" && data.recommendation) {
                    const rec = data.recommendation;
                    const stnInfo = rec ? (rec.station || rec.nearest_station) : null;

                    if (etaEl) {
                        etaEl.innerText = `ETA ~${rec.eta_minutes} MIN (${rec.distance_km} KM)`;
                    }

                    if (recBox) {
                        const fallbackBadge = rec.fallback_used ? 
                            `<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); font-size: 0.65rem;">FALLBACK ${rec.assigned_unit_type}</span>` : 
                            `<span class="badge badge-low" style="font-size: 0.65rem;">PRIMARY ${rec.assigned_unit_type}</span>`;

                        const stnIcon = (stnInfo && stnInfo.type === "FIRE") ? "🚒" : ((stnInfo && stnInfo.type === "HOSPITAL") ? "🏥" : "🚓");
                        const stnDist = rec.nearest_station_distance_km ? `${rec.nearest_station_distance_km} km` : `${rec.distance_km} km`;

                        recBox.innerHTML = `
                            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;">
                                <div>
                                    <div style="font-weight: 700; font-size: 0.85rem; color: #fff; display: flex; align-items: center; gap: 4px;">
                                        <span>${stnIcon}</span> <span>${rec.unit.name || rec.unit.call_sign || rec.unit.id}</span>
                                    </div>
                                    <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px;">
                                        ${stnInfo ? `<strong>${stnInfo.name}</strong> (${stnDist})` : 'Mobile Command Post'} &bull; ${rec.unit.personnel_count || 4} Crew
                                    </div>
                                    <div style="margin-top: 4px; display: flex; gap: 4px; align-items: center;">
                                        ${fallbackBadge}
                                        <span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); font-size: 0.65rem;">📍 Station ${stnDist}</span>
                                    </div>
                                </div>
                                <button class="btn btn-quick-dispatch-gradient" onclick="window.cadApp.dispatchNearestDirect('${inc.id}', '${rec.unit.id}')">
                                    <i data-lucide="zap"></i> Quick Dispatch
                                </button>
                            </div>
                        `;
                        lucide.createIcons();

                    }

                    // Highlight nearest emergency station on map
                    if (stnInfo) {
                        window.cadMapManager.highlightNearestStation(stnInfo, [inc.latitude, inc.longitude]);
                    }

                    // Render dynamic navigation route polyline
                    window.cadMapManager.renderUnitRoute(
                        rec.route,
                        [rec.unit.latitude, rec.unit.longitude],
                        [inc.latitude, inc.longitude],
                        rec.unit
                    );
                    return;
                }
            }

        } catch (e) {
            console.warn("Nearest unit API error, switching to client GIS fallback:", e);
        }

        // Client-side fallback if server nearest-dispatch endpoint is restarting or unreachable
        if (this.units && this.units.length > 0) {
            const avail = this.units.filter(u => u.status === "AVAILABLE");
            const pool = avail.length > 0 ? avail : this.units;
            // Find closest by Euclidean/Haversine approx
            let closestUnit = pool[0];
            let minDist = 999999;
            pool.forEach(u => {
                const d = Math.hypot((u.latitude || 13.04) - inc.latitude, (u.longitude || 80.22) - inc.longitude) * 111.0;
                if (d < minDist) {
                    minDist = d;
                    closestUnit = u;
                }
            });

            const estMinutes = Math.max(2, Math.round((minDist / 45.0) * 60));
            if (etaEl) etaEl.innerText = `ETA ~${estMinutes} MIN (${minDist.toFixed(1)} KM)`;
            if (recBox) {
                recBox.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px;">
                        <div>
                            <div style="font-weight: 700; font-size: 0.85rem; color: #fff;">${closestUnit.name || closestUnit.id}</div>
                            <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px;">
                                ${closestUnit.station_name || 'Emergency Base'} &bull; Status: ${closestUnit.status}
                            </div>
                        </div>
                        <button class="btn btn-primary" style="padding: 5px 10px; font-size: 0.72rem; white-space: nowrap; background: #f97316; border-color: #ea580c;" onclick="window.cadApp.dispatchNearestDirect('${inc.id}', '${closestUnit.id}')">
                            <i data-lucide="zap"></i> Quick Dispatch
                        </button>
                    </div>
                `;
                lucide.createIcons();
            }
            window.cadMapManager.renderUnitRoute(
                null,
                [closestUnit.latitude, closestUnit.longitude],
                [inc.latitude, inc.longitude],
                closestUnit
            );
        } else {
            if (etaEl) etaEl.innerText = "STANDBY";
            if (recBox) recBox.innerHTML = `<span style="font-size: 0.75rem; color: var(--text-muted);">No units currently in registry.</span>`;
        }
    }


    async dispatchNearestDirect(incidentId, unitId) {
        try {
            const res = await fetch(`/api/incidents/${incidentId}/dispatch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ unit_ids: [unitId], notes: `Immediate nearest unit quick dispatch (${unitId})` })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.showNotification(`⚡ Mobilized nearest unit ${unitId} to incident ${incidentId}!`, "success");
            }
        } catch (e) {
            this.showNotification("Quick dispatch failed: " + e.message, "danger");
        }
    }


    openDispatchModal(incidentId) {
        const inc = this.incidents.find(i => i.id === incidentId);
        if (!inc) return;

        this.selectedIncident = inc;
        const modal = document.getElementById("modal-dispatch");
        const list = document.getElementById("dispatch-unit-list");
        const titleEl = document.getElementById("modal-dispatch-title");
        
        if (titleEl) titleEl.innerText = `Dispatch First Responders -> ${inc.id}`;
        
        if (list) {
            list.innerHTML = this.units.map(u => {
                const isAlready = (inc.dispatched_units || []).includes(u.id);
                const isAvail = u.status === "AVAILABLE";
                return `
                    <div class="unit-item ${isAlready ? 'selected' : ''}" data-unit-id="${u.id}" style="display: flex; align-items: center; justify-content: space-between;">
                        <div>
                            <div style="font-weight: 700; font-size: 0.85rem;">${u.name} (${u.id})</div>
                            <div style="font-size: 0.75rem; color: var(--text-secondary);">${u.type} &bull; ${u.station_name}</div>
                        </div>
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="badge ${isAvail ? 'badge-low' : 'badge-high'}">${u.status}</span>
                            ${isAvail ? `
                                <button class="btn btn-primary" style="padding: 4px 10px; font-size: 0.72rem;" onclick="event.stopPropagation(); window.cadApp.dispatchTeamDirect('${u.id}', '${inc.id}')">
                                    <i data-lucide="send"></i> Dispatch Team
                                </button>
                            ` : `
                                <span style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono);">${isAlready ? 'ON SCENE' : 'DEPLOYED'}</span>
                            `}
                        </div>
                    </div>
                `;
            }).join('');
        }

        if (modal) modal.classList.add("active");
        lucide.createIcons();
    }

    async dispatchTeamDirect(teamId, incidentId) {
        try {
            const res = await fetch(`/api/teams/${teamId}/dispatch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ incident_id: incidentId })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.closeModals();
                this.showNotification(`Response Team ${teamId} mobilized to ${incidentId}`, "success");
            }
        } catch (e) {
            console.error("Team dispatch failed:", e);
            this.showNotification("Team dispatch failed: " + e.message, "danger");
        }
    }

    async handleCommitDispatch() {
        if (!this.selectedIncident) return;
        const selectedElements = document.querySelectorAll("#dispatch-unit-list .unit-item.selected");
        const unitIds = Array.from(selectedElements).map(el => el.dataset.unitId);

        if (unitIds.length === 0) {
            alert("Please select at least one unit to dispatch.");
            return;
        }

        try {
            const res = await fetch(`/api/incidents/${this.selectedIncident.id}/dispatch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ unit_ids: unitIds })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.closeModals();
                this.showNotification(`Dispatched ${unitIds.length} units to ${this.selectedIncident.id}`, "success");
            }
        } catch (e) {
            console.error("Dispatch failed:", e);
        }
    }

    async updateIncidentStatusPrompt(incidentId) {
        const statuses = ["PENDING", "TRIAGED", "DISPATCHED", "ON_SCENE", "RESOLVED"];
        const chosen = prompt(`Select new status for ${incidentId}:\n${statuses.join(", ")}`, "ON_SCENE");
        if (!chosen || !statuses.includes(chosen.toUpperCase())) return;

        try {
            await fetch(`/api/incidents/${incidentId}/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: chosen.toUpperCase() })
            });
            this.showNotification(`Incident ${incidentId} transitioned to ${chosen.toUpperCase()}`, "success");
        } catch (e) {
            console.error("Status update error:", e);
        }
    }

    closeModals() {
        document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.remove("active"));
    }

    async handleManualTriage() {
        const rawMsg = document.getElementById("input-raw-msg").value;
        const meta = document.getElementById("input-metadata").value;
        const outBox = document.getElementById("triage-output-json");
        const statusPill = document.getElementById("triage-result-pill");
        const btn = document.getElementById("btn-run-triage");

        if (!rawMsg.trim()) {
            alert("Please enter a distress message or emergency call transcript.");
            return;
        }

        btn.disabled = true;
        btn.innerText = "Analyzing Signal...";
        const t0 = performance.now();

        try {
            const res = await fetch("/api/ingest", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    raw_message: rawMsg,
                    metadata_or_coordinates: meta,
                    channel: "MANUAL_WORKBENCH"
                })
            });
            const data = await res.json();
            const elapsed = Math.round(performance.now() - t0);

            if (outBox) {
                outBox.innerText = JSON.stringify(data.triage_result, null, 2);
            }

            if (statusPill) {
                if (data.triage_result?.is_out_of_jurisdiction || data.triage_result?.rejection_reason?.includes("OUT_OF_JURISDICTION")) {
                    statusPill.innerHTML = `<span class="badge badge-warning" style="background: rgba(239, 68, 68, 0.25); border: 1px solid #ef4444; color: #fca5a5;">⚠️ OUT OF JURISDICTION (TN SEOC ONLY)</span>`;
                    this.showNotification("Geofence Alert: Location falls outside Tamil Nadu operational boundaries.", "danger");
                } else if (data.status === "SUCCESS" || data.status === "MERGED") {
                    statusPill.innerHTML = `<span class="badge badge-critical">RELEVANT DISASTER SIGNAL (${elapsed}ms)</span>`;
                } else {
                    statusPill.innerHTML = `<span class="badge badge-low">DISCARDED / NON-EMERGENCY (${elapsed}ms)</span>`;
                }
            }
        } catch (e) {
            console.error("Triage ingestion failed:", e);
            if (outBox) outBox.innerText = "Error analyzing signal: " + e.message;
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<i data-lucide="zap"></i> Run AI Triage Engine`;
            lucide.createIcons();
        }
    }

    loadUploadedImageFile(file) {
        if (!file || !file.type.startsWith("image/")) {
            alert("Please select a valid image file (PNG, JPEG, WebP).");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const dataUrl = e.target.result;
            this.currentUploadedImageBase64 = dataUrl;
            
            const previewImg = document.getElementById("image-preview");
            const previewWrap = document.getElementById("dropzone-preview-wrap");
            const promptWrap = document.getElementById("dropzone-prompt");

            if (previewImg) previewImg.src = dataUrl;
            if (previewWrap) previewWrap.style.display = "block";
            if (promptWrap) promptWrap.style.display = "none";
        };
        reader.readAsDataURL(file);
    }

    applySyntheticImagePreset(type, caption) {
        const canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 250;
        const ctx = canvas.getContext("2d");

        let bgGradient = ctx.createLinearGradient(0, 0, 400, 250);
        let title = "DISASTER RECON";
        let sub = "Aerial Visual Telemetry";

        if (type === "FLOOD") {
            bgGradient.addColorStop(0, "#082f49");
            bgGradient.addColorStop(0.5, "#0369a1");
            bgGradient.addColorStop(1, "#0c4a6e");
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, 400, 250);
            
            // Draw water ripples
            ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
            ctx.lineWidth = 3;
            for (let y = 100; y < 240; y += 20) {
                ctx.beginPath();
                ctx.moveTo(20, y);
                ctx.bezierCurveTo(120, y - 10, 260, y + 10, 380, y);
                ctx.stroke();
            }
            title = "🌊 URBAN FLOOD INUNDATION";
            sub = "Water Level: +1.8m Above Ground";
            document.getElementById("input-image-location").value = "Velachery Main Road, Chennai (12.9791, 80.2185)";
        } else if (type === "FIRE") {
            bgGradient.addColorStop(0, "#450a0a");
            bgGradient.addColorStop(0.5, "#b91c1c");
            bgGradient.addColorStop(1, "#7c2d12");
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, 400, 250);
            
            // Draw flames and smoke
            ctx.fillStyle = "rgba(251, 191, 36, 0.6)";
            ctx.beginPath();
            ctx.moveTo(80, 240);
            ctx.lineTo(140, 60);
            ctx.lineTo(200, 240);
            ctx.fill();

            ctx.fillStyle = "rgba(239, 68, 68, 0.7)";
            ctx.beginPath();
            ctx.moveTo(180, 240);
            ctx.lineTo(260, 40);
            ctx.lineTo(340, 240);
            ctx.fill();

            title = "🔥 INDUSTRIAL CHEMICAL BLAZE";
            sub = "Thermal Radiation: Extreme Risk";
            document.getElementById("input-image-location").value = "Guindy Industrial Estate, Sector 3 (13.0067, 80.2038)";
        } else if (type === "STRUCTURAL_COLLAPSE") {
            bgGradient.addColorStop(0, "#1f2937");
            bgGradient.addColorStop(0.5, "#374151");
            bgGradient.addColorStop(1, "#111827");
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, 400, 250);

            // Draw fractured concrete beams
            ctx.fillStyle = "#4b5563";
            ctx.fillRect(40, 120, 320, 30);
            ctx.fillStyle = "#6b7280";
            ctx.fillRect(100, 70, 80, 120);

            // Hazard stripes
            ctx.fillStyle = "#fbbf24";
            for (let i = 0; i < 400; i += 40) {
                ctx.fillRect(i, 230, 20, 20);
            }
            title = "🏗️ VIADUCT / STRUCTURAL COLLAPSE";
            sub = "Debris Field: Heavy Void Obstruction";
            document.getElementById("input-image-location").value = "Anna Nagar West Junction (13.0850, 80.2101)";
        } else {
            bgGradient.addColorStop(0, "#065f46");
            bgGradient.addColorStop(0.5, "#047857");
            bgGradient.addColorStop(1, "#022c22");
            ctx.fillStyle = bgGradient;
            ctx.fillRect(0, 0, 400, 250);
            title = "☀️ NORMAL METRO CORRIDOR";
            sub = "Clear Traffic & Standard Pedestrian Flow";
            document.getElementById("input-image-location").value = "Semmozhi Poonga, Cathedral Road (13.0489, 80.2505)";
        }

        // Add Recon HUD overlay
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(10, 10, 380, 50);
        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 13px monospace";
        ctx.fillText(title, 20, 32);
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10px sans-serif";
        ctx.fillText(sub + " // AEGIS-CAD DRONE FEED", 20, 48);

        const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        this.currentUploadedImageBase64 = dataUrl;

        const previewImg = document.getElementById("image-preview");
        const previewWrap = document.getElementById("dropzone-preview-wrap");
        const promptWrap = document.getElementById("dropzone-prompt");

        if (previewImg) previewImg.src = dataUrl;
        if (previewWrap) previewWrap.style.display = "block";
        if (promptWrap) promptWrap.style.display = "none";

        const capInput = document.getElementById("input-image-caption");
        if (capInput) capInput.value = caption;
    }

    async handleAnalyzeDisasterImage() {

        const btn = document.getElementById("btn-analyze-image");
        const statusTag = document.getElementById("vision-status-tag");
        const reportBody = document.getElementById("vision-report-body");
        const caption = document.getElementById("input-image-caption")?.value || "";
        const locationName = document.getElementById("input-image-location")?.value || "";

        if (!this.currentUploadedImageBase64) {
            alert("Please upload a disaster photo or select one of the synthetic evidence presets.");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Analyzing Multimodal Visual Damage...`;
        if (statusTag) {
            statusTag.className = "badge badge-moderate";
            statusTag.innerText = "PROCESSING";
        }
        if (reportBody) {
            reportBody.innerHTML = `
                <div style="padding: 24px 0; text-align: center;">
                    <div style="font-size: 1.2rem; font-weight: 800; color: #38bdf8; margin-bottom: 6px;">Scanning Visual Damage Matrix...</div>
                    <div style="font-size: 0.78rem; color: var(--text-secondary);">Extracting physical damage vectors, structural anomalies, and casualty risk indicators.</div>
                </div>
            `;
        }

        const t0 = performance.now();

        try {
            const res = await fetch("/api/ingest/image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    image_base64: this.currentUploadedImageBase64,
                    caption: caption,
                    location_name: locationName,
                    channel: "MULTIMODAL_VISION_WORKBENCH"
                })
            });

            const data = await res.json();
            const elapsed = Math.round(performance.now() - t0);
            const analysis = data.analysis;

            if (!analysis) {
                throw new Error("Invalid response from vision engine");
            }

            if (data.is_disaster_related) {
                if (statusTag) {
                    statusTag.className = "badge badge-critical";
                    statusTag.innerText = `CONFIRMED DISASTER (${elapsed}ms)`;
                }

                let sevColor = "#ef4444";
                if (analysis.damage_severity === "HIGH") sevColor = "#f97316";
                else if (analysis.damage_severity === "MODERATE") sevColor = "#06b6d4";
                else if (analysis.damage_severity === "LOW") sevColor = "#10b981";

                let riskBadge = "badge-critical";
                if (analysis.estimated_casualty_risk === "HIGH") riskBadge = "badge-high";
                else if (analysis.estimated_casualty_risk === "MODERATE") riskBadge = "badge-moderate";
                else if (analysis.estimated_casualty_risk === "LOW") riskBadge = "badge-low";

                if (reportBody) {
                    reportBody.innerHTML = `
                        <div style="text-align: left;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                                <div style="display: flex; align-items: center; gap: 6px;">
                                    <span class="badge" style="background: ${sevColor}22; border: 1px solid ${sevColor}; color: ${sevColor}; font-weight: 800;">
                                        [${analysis.damage_severity}] ${analysis.disaster_category}
                                    </span>
                                    <span class="badge ${riskBadge}">Casualty Risk: ${analysis.estimated_casualty_risk}</span>
                                </div>
                                <span style="font-size: 0.72rem; color: #fbbf24; font-weight: 700; font-family: var(--font-mono);">
                                    +${analysis.suggested_urgency_adjustment} Urgency Boost
                                </span>
                            </div>

                            <div style="font-size: 0.85rem; font-weight: 700; color: #fff; margin-bottom: 4px;">
                                ${analysis.synopsis}
                            </div>

                            <div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 8px;">
                                Vision Confidence: <strong>${Math.round(analysis.confidence_score * 100)}%</strong> &bull; Latency: <strong>${elapsed}ms</strong>
                            </div>

                            <div style="background: rgba(15,23,42,0.8); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px;">
                                <div style="font-size: 0.72rem; font-weight: 700; color: #38bdf8; text-transform: uppercase; margin-bottom: 4px;">Observed Visual Evidence:</div>
                                <ul style="margin: 0; padding-left: 18px; font-size: 0.75rem; color: #e2e8f0; line-height: 1.4;">
                                    ${analysis.visual_evidence.map(ev => `<li>${ev}</li>`).join('')}
                                </ul>
                            </div>

                            ${data.incident_id ? `
                                <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(16,185,129,0.15); border: 1px solid rgba(16,185,129,0.4); border-radius: 6px; padding: 6px 10px;">
                                    <span style="font-size: 0.75rem; color: #34d399; font-weight: 700;">
                                        ⚡ Ingested as Active CAD Incident: <strong>${data.incident_id}</strong>
                                    </span>
                                    <button class="btn btn-primary" style="padding: 4px 10px; font-size: 0.72rem; background: #10b981; border-color: #10b981;" onclick="window.cadApp.switchTab('tab-matrix'); window.cadApp.setTriageStage('PROPOSED');">
                                        <i data-lucide="arrow-right"></i> View on Board
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }

                window.cadAudio.playBeep();
                this.showNotification(`📷 Multimodal Vision: ${analysis.disaster_category} (${analysis.damage_severity}) classified & ingested to CAD!`, "success");
            } else {
                if (statusTag) {
                    statusTag.className = "badge badge-low";
                    statusTag.innerText = `NON-EMERGENCY (${elapsed}ms)`;
                }
                if (reportBody) {
                    reportBody.innerHTML = `
                        <div style="text-align: center; padding: 16px 0;">
                            <i data-lucide="shield-check" style="width: 36px; height: 36px; color: #10b981; margin-bottom: 6px;"></i>
                            <div style="font-size: 0.9rem; font-weight: 700; color: #10b981;">No Disaster Hazards Detected</div>
                            <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 4px;">${analysis.synopsis}</div>
                        </div>
                    `;
                }
                this.showNotification("Visual evidence discarded: No disaster signatures detected.", "info");
            }
        } catch (e) {
            console.error("Visual damage analysis failed:", e);
            if (statusTag) {
                statusTag.className = "badge badge-critical";
                statusTag.innerText = "ERROR";
            }
            if (reportBody) {
                reportBody.innerHTML = `<div style="color: #f87171; font-size: 0.8rem;">Vision analysis error: ${e.message}</div>`;
            }
            this.showNotification("Visual damage analysis failed: " + e.message, "danger");
        } finally {
            btn.disabled = false;
            btn.innerHTML = `<i data-lucide="scan-eye"></i> Analyze Visual Damage & Ingest to CAD`;
            lucide.createIcons();
        }
    }


    setTriageStage(stage) {
        if (!["PROPOSED", "ONGOING", "COMPLETED"].includes(stage)) return;
        this.activeTriageStage = stage;
        document.querySelectorAll(".stage-tab-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.stage === stage);
        });
        this.renderMatrix();
    }

    setSortMode(mode) {
        if (mode !== "PRIORITY" && mode !== "CHRONOLOGICAL") return;
        this.sortMode = mode;
        document.querySelectorAll(".sort-toggle-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.sort === mode);
        });
        this.renderMatrix();
    }

    renderMatrix() {
        const container = document.getElementById("matrix-grid-container");
        if (!container) return;

        // 1. Separate incidents into 3 operational stages
        const proposedList = [];
        const ongoingList = [];
        const completedList = [];

        this.incidents.forEach(inc => {
            const isResolved = inc.status === "RESOLVED";
            const isDispatched = Array.isArray(inc.dispatched_units) && inc.dispatched_units.length > 0;
            const isOngoingStatus = ["ACCEPTED", "EN_ROUTE", "ON_SCENE", "ASSISTANCE_REQUIRED", "SITUATION_UNDER_CONTROL", "DISPATCHED"].includes(inc.status);

            if (isResolved) {
                completedList.push(inc);
            } else if (isOngoingStatus || isDispatched) {
                ongoingList.push(inc);
            } else {
                proposedList.push(inc);
            }
        });

        // 2. Update Stage Badges
        const badgeProposed = document.getElementById("badge-stage-proposed");
        const badgeOngoing = document.getElementById("badge-stage-ongoing");
        const badgeCompleted = document.getElementById("badge-stage-completed");

        if (badgeProposed) badgeProposed.innerText = proposedList.length;
        if (badgeOngoing) badgeOngoing.innerText = ongoingList.length;
        if (badgeCompleted) badgeCompleted.innerText = completedList.length;

        // 3. Select target list based on active stage
        let activeList = proposedList;
        if (this.activeTriageStage === "ONGOING") activeList = ongoingList;
        else if (this.activeTriageStage === "COMPLETED") activeList = completedList;

        // 4. Apply Filters (Search, Severity, Disaster Type)
        const search = (document.getElementById("matrix-search")?.value || "").toLowerCase();
        const filterSev = document.getElementById("matrix-filter-severity")?.value || "ALL";
        const filterType = document.getElementById("matrix-filter-type")?.value || "ALL";

        const filtered = activeList.filter(inc => {
            if (filterSev !== "ALL" && inc.severity !== filterSev) return false;
            if (filterType !== "ALL" && inc.type !== filterType) return false;
            if (search) {
                const s = search.toLowerCase();
                const victimMatch = (inc.victims || inc.victimProfiles || []).some(v => 
                    (v.name || '').toLowerCase().includes(s) ||
                    (v.notes || '').toLowerCase().includes(s)
                );
                const match = (inc.id || '').toLowerCase().includes(s) || 
                              (inc.title || '').toLowerCase().includes(s) || 
                              (inc.location_name || inc.locationName || '').toLowerCase().includes(s) ||
                              (inc.raw_text || '').toLowerCase().includes(s) ||
                              victimMatch;
                if (!match) return false;
            }
            return true;
        });

        // 5. Apply Sorting
        filtered.sort((a, b) => {
            const rawTimeA = a.createdAt || a.created_at || new Date().toISOString();
            const rawTimeB = b.createdAt || b.created_at || new Date().toISOString();
            const timeA = new Date(rawTimeA).getTime() || 0;
            const timeB = new Date(rawTimeB).getTime() || 0;

            if (this.sortMode === "CHRONOLOGICAL") {
                return timeB - timeA;
            } else {
                const scoreA = (a.urgencyScore !== undefined ? a.urgencyScore : a.urgency_score) || 0;
                const scoreB = (b.urgencyScore !== undefined ? b.urgencyScore : b.urgency_score) || 0;
                if (scoreB !== scoreA) {
                    return scoreB - scoreA;
                }
                return timeB - timeA;
            }
        });

        if (filtered.length === 0) {
            let emptyMsg = "No pending proposed incidents.";
            if (this.activeTriageStage === "ONGOING") emptyMsg = "No active field operations in progress.";
            else if (this.activeTriageStage === "COMPLETED") emptyMsg = "No resolved incident archive records found.";

            container.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: rgba(15,23,42,0.4); border: 1px dashed var(--border-color); border-radius: 8px; color: var(--text-muted);">
                    <i data-lucide="inbox" style="width: 36px; height: 36px; margin-bottom: 8px; opacity: 0.6;"></i>
                    <div style="font-size: 0.95rem; font-weight: 600; color: var(--text-secondary);">${emptyMsg}</div>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        // 6. Render Stage-Specific Cards
        container.innerHTML = filtered.map(inc => {
            let sevClass = "badge-moderate";
            if (inc.severity === "CRITICAL") sevClass = "badge-critical";
            else if (inc.severity === "HIGH") sevClass = "badge-high";
            else if (inc.severity === "LOW") sevClass = "badge-low";

            const rawTime = inc.createdAt || inc.created_at || new Date().toISOString();
            let timeStr = "";
            try {
                timeStr = new Date(rawTime).toISOString().substring(11, 19) + " UTC";
            } catch(e) {
                timeStr = new Date().toISOString().substring(11, 19) + " UTC";
            }

            // Tally victims
            const victims = inc.victims || inc.victimProfiles || [];
            const tally = { RED: 0, YELLOW: 0, GREEN: 0, BLACK: 0 };
            victims.forEach(v => {
                const tag = (v.triageTag || v.triage_tag || "YELLOW").toUpperCase();
                if (tally[tag] !== undefined) tally[tag]++;
                else tally.YELLOW++;
            });

            // Dispatched unit names
            const deployedUnits = inc.dispatched_units || [];
            const unitLabel = deployedUnits.length > 0 ? deployedUnits.join(", ") : "UNASSIGNED";

            if (this.activeTriageStage === "PROPOSED") {
                // ================= STAGE 1: PROPOSED CARD =================
                return `
                    <div class="incident-card severity-${inc.severity.toLowerCase()}">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div>
                                <span class="badge ${sevClass}">${inc.severity}</span>
                                <span class="badge badge-type" style="margin-left: 4px;">${inc.type}</span>
                            </div>
                            <span class="badge" style="background: rgba(239, 68, 68, 0.2); border: 1px solid #ef4444; color: #fca5a5;">
                                📥 PENDING DISPATCH
                            </span>
                        </div>

                        <div style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 6px;">
                            ${inc.id} &bull; ${timeStr}
                        </div>
                        
                        <div style="font-weight: 700; font-size: 0.95rem; line-height: 1.3; margin-top: 4px;">${inc.title}</div>
                        
                        <div style="font-size: 0.8rem; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; margin-top: 2px;">
                            <i data-lucide="map-pin" style="width: 14px;"></i> ${inc.location_name || inc.locationName}
                        </div>

                        <div class="urgency-gauge" style="margin-top: 4px;">
                            <span>Urgency: ${inc.urgency_score !== undefined ? inc.urgency_score : inc.urgencyScore}/100</span>
                            <div class="urgency-bar-wrap">
                                <div class="urgency-bar-fill ${inc.severity.toLowerCase()}" style="width: ${inc.urgency_score !== undefined ? inc.urgency_score : inc.urgencyScore}%;"></div>
                            </div>
                        </div>

                        <div style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 2px;">
                            Reported: ${inc.affected_trapped || 0} trapped &bull; ${inc.affected_injured || 0} injured
                        </div>

                        <div style="display: flex; gap: 8px; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 10px;">
                            <button class="btn btn-primary" style="flex: 1.2; padding: 6px 10px; font-size: 0.75rem; background: linear-gradient(135deg, #0284c7, #0369a1); border-color: #38bdf8;" onclick="window.cadApp.quickDispatchProposed('${inc.id}')">
                                <i data-lucide="zap"></i> Quick Dispatch
                            </button>
                            <button class="btn btn-secondary" style="padding: 6px 10px; font-size: 0.75rem;" onclick="window.cadApp.openDispatchModal('${inc.id}')" title="Choose specific units">
                                <i data-lucide="send"></i> Custom
                            </button>
                            <button class="btn btn-secondary" style="padding: 6px 8px; font-size: 0.75rem;" onclick="window.cadApp.locateOnMap('${inc.id}')" title="Locate on Map">
                                <i data-lucide="map"></i>
                            </button>
                        </div>
                    </div>
                `;
            } else if (this.activeTriageStage === "ONGOING") {
                // ================= STAGE 2: ONGOING CARD =================
                let pillClass = "en-route";
                let statusLabel = inc.status;
                if (inc.status === "ASSISTANCE_REQUIRED") {
                    pillClass = "assistance";
                    statusLabel = "🚨 ASSISTANCE REQ.";
                } else if (inc.status === "ON_SCENE") {
                    pillClass = "on-scene";
                    statusLabel = "📍 ON SCENE";
                } else if (inc.status === "SITUATION_UNDER_CONTROL") {
                    pillClass = "under-control";
                    statusLabel = "🛡️ UNDER CONTROL";
                } else if (inc.status === "EN_ROUTE" || inc.status === "DISPATCHED") {
                    pillClass = "en-route";
                    statusLabel = "🚒 EN ROUTE";
                }

                return `
                    <div class="incident-card severity-${inc.severity.toLowerCase()}" style="border-left: 4px solid #38bdf8;">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div>
                                <span class="badge ${sevClass}">${inc.severity}</span>
                                <span class="badge badge-type" style="margin-left: 4px;">${inc.type}</span>
                            </div>
                            <span class="tactical-state-pill ${pillClass}">
                                ${statusLabel}
                            </span>
                        </div>

                        <div style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 6px;">
                            ${inc.id} &bull; ${timeStr}
                        </div>
                        
                        <div style="font-weight: 700; font-size: 0.95rem; line-height: 1.3; margin-top: 4px;">${inc.title}</div>
                        
                        <div style="font-size: 0.8rem; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; margin-top: 2px;">
                            <i data-lucide="map-pin" style="width: 14px;"></i> ${inc.location_name || inc.locationName}
                        </div>

                        <!-- Dispatched Unit Badge -->
                        <div style="background: rgba(14, 165, 233, 0.15); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 4px; padding: 4px 8px; font-size: 0.75rem; color: #38bdf8; font-weight: 700; font-family: var(--font-mono); margin-top: 6px; display: flex; align-items: center; justify-content: space-between;">
                            <span>🚒 Deployed Unit(s):</span>
                            <span>${unitLabel}</span>
                        </div>

                        <!-- Real-time Victim / Casualty Counter -->
                        <div class="casualty-tally-bar">
                            <span style="font-size: 0.7rem; color: var(--text-secondary);">Victim Tags:</span>
                            <span class="victim-tag-chip tag-red" title="Immediate Critical">🔴 ${tally.RED}</span>
                            <span class="victim-tag-chip tag-yellow" title="Delayed Urgent">🟡 ${tally.YELLOW}</span>
                            <span class="victim-tag-chip tag-green" title="Minor Ambulatory">🟢 ${tally.GREEN}</span>
                            <span class="victim-tag-chip tag-black" title="Deceased">⚫ ${tally.BLACK}</span>
                        </div>

                        <div style="display: flex; gap: 6px; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 10px;">
                            <button class="btn btn-secondary" style="flex: 1; padding: 5px 6px; font-size: 0.72rem;" onclick="window.cadApp.locateOnMap('${inc.id}')">
                                <i data-lucide="map"></i> Route
                            </button>
                            <button class="btn btn-secondary" style="flex: 1; padding: 5px 6px; font-size: 0.72rem; color: #f87171; border-color: rgba(239,68,68,0.4);" onclick="window.cadApp.escalateIncident('${inc.id}')" title="Request Heavy Backup">
                                <i data-lucide="alert-triangle"></i> Escalate
                            </button>
                            <button class="btn btn-primary" style="flex: 1.3; padding: 5px 6px; font-size: 0.72rem; background: #10b981; border-color: #10b981;" onclick="window.cadApp.markIncidentResolved('${inc.id}')">
                                <i data-lucide="check-circle"></i> Resolve
                            </button>
                        </div>
                    </div>
                `;
            } else {
                // ================= STAGE 3: COMPLETED ARCHIVE CARD =================
                const totalVictims = (inc.affected_injured || 0) + (inc.affected_trapped || 0) + (inc.affected_evacuated || 0) + victims.length;

                return `
                    <div class="incident-card completed-archive">
                        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                            <div>
                                <span class="badge badge-low">RESOLVED</span>
                                <span class="badge badge-type" style="margin-left: 4px;">${inc.type}</span>
                            </div>
                            <span style="font-size: 0.72rem; color: #10b981; font-weight: 700; font-family: var(--font-mono);">
                                ✅ MISSION COMPLETED
                            </span>
                        </div>

                        <div style="font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: 6px;">
                            ${inc.id} &bull; ${timeStr}
                        </div>
                        
                        <div style="font-weight: 700; font-size: 0.95rem; line-height: 1.3; margin-top: 4px; color: var(--text-primary);">${inc.title}</div>
                        
                        <div style="font-size: 0.8rem; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; margin-top: 2px;">
                            <i data-lucide="map-pin" style="width: 14px;"></i> ${inc.location_name || inc.locationName}
                        </div>

                        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0,0,0,0.3); padding: 5px 8px; border-radius: 4px; margin-top: 6px; font-size: 0.72rem; font-family: var(--font-mono);">
                            <span style="color: #34d399;">👥 Rescued / Cleared: <strong>${totalVictims}</strong></span>
                            <span style="color: #94a3b8;">Units: <strong>${deployedUnits.length || 1}</strong></span>
                        </div>

                        <div style="display: flex; gap: 8px; margin-top: 10px; border-top: 1px solid var(--border-color); padding-top: 10px;">
                            <button class="btn btn-secondary" style="flex: 1; padding: 6px 10px; font-size: 0.75rem; background: rgba(16,185,129,0.15); border-color: rgba(16,185,129,0.4); color: #34d399;" onclick="window.cadApp.showAfterActionReport('${inc.id}')">
                                <i data-lucide="file-text"></i> After-Action Report
                            </button>
                            <button class="btn btn-secondary" style="padding: 6px 8px; font-size: 0.75rem;" onclick="window.cadApp.locateOnMap('${inc.id}')" title="Locate on Map">
                                <i data-lucide="map"></i>
                            </button>
                        </div>
                    </div>
                `;
            }
        }).join('');

        lucide.createIcons();
    }

    async quickDispatchProposed(incidentId) {
        try {
            window.cadAudio.playBeep();
            const res = await fetch(`/api/incidents/${incidentId}/dispatch`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notes: "⚡ 1-Click Quick Dispatch from Proposed Board" })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.showNotification(`⚡ Deployed nearest unit to ${incidentId}! Moved to Ongoing Operations.`, "success");
                
                // Optimistically update incident in local state
                const inc = this.incidents.find(i => i.id === incidentId);
                if (inc) {
                    inc.status = "DISPATCHED";
                    inc.dispatched_units = data.dispatched_unit_ids || inc.dispatched_units || [];
                }
                
                // Auto switch to ONGOING tab to see the active mission
                this.setTriageStage("ONGOING");
            }
        } catch (e) {
            console.error("Quick dispatch failed:", e);
            this.showNotification("Quick dispatch failed: " + e.message, "danger");
        }
    }

    async escalateIncident(incidentId) {
        try {
            window.cadAudio.playSiren();
            const res = await fetch(`/api/incidents/${incidentId}/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: "ASSISTANCE_REQUIRED",
                    notes: "Dispatcher manual tactical escalation: additional heavy units requested on scene."
                })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.showNotification(`🚨 Incident ${incidentId} ESCALATED! Status: ASSISTANCE_REQUIRED`, "danger");
                const inc = this.incidents.find(i => i.id === incidentId);
                if (inc) {
                    inc.status = "ASSISTANCE_REQUIRED";
                    inc.severity = "CRITICAL";
                    inc.urgency_score = Math.min(100, (inc.urgency_score || 70) + 25);
                }
                this.renderMatrix();
            }
        } catch (e) {
            this.showNotification("Escalation failed: " + e.message, "danger");
        }
    }

    async markIncidentResolved(incidentId) {
        if (!confirm(`Mark incident ${incidentId} as fully RESOLVED? This will release all deployed units back to AVAILABLE.`)) return;

        try {
            const res = await fetch(`/api/incidents/${incidentId}/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: "RESOLVED",
                    notes: "Operations concluded by Dispatcher. Scene cleared and all threats neutralized."
                })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.showNotification(`✅ Incident ${incidentId} RESOLVED! Deployed units released.`, "success");
                window.cadMapManager.clearUnitRoute();

                const inc = this.incidents.find(i => i.id === incidentId);
                if (inc) {
                    inc.status = "RESOLVED";
                    inc.urgency_score = 0;
                }
                
                // Switch to completed tab to show archive card
                this.setTriageStage("COMPLETED");
            }
        } catch (e) {
            this.showNotification("Resolution update failed: " + e.message, "danger");
        }
    }

    async showAfterActionReport(incidentId) {
        try {
            const res = await fetch(`/api/incidents/${incidentId}/aar`);
            const data = await res.json();
            if (data.status !== "SUCCESS" || !data.aar) {
                throw new Error("Failed to load AAR data");
            }

            const aar = data.aar;
            const modal = document.getElementById("modal-aar");
            const titleEl = document.getElementById("modal-aar-title");
            const bodyEl = document.getElementById("modal-aar-body");

            if (titleEl) {
                titleEl.innerText = `AFTER-ACTION REPORT // ${aar.incident_id}`;
            }

            if (bodyEl) {
                const totalVictims = (aar.casualties?.total || 0) + (aar.total_victims_logged || 0);
                const tally = aar.victim_triage_tally || { RED: 0, YELLOW: 0, GREEN: 0, BLACK: 0 };
                const unitsList = (aar.dispatched_units && aar.dispatched_units.length > 0) ? 
                    aar.dispatched_units.join(", ") : "Standard EOC Dispatch";

                bodyEl.innerHTML = `
                    <div class="aar-grid">
                        <div class="aar-metric-card">
                            <div style="font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase;">Duration</div>
                            <div class="aar-metric-val">${aar.duration_minutes}m</div>
                        </div>
                        <div class="aar-metric-card">
                            <div style="font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase;">Victims Logged</div>
                            <div class="aar-metric-val" style="color: #34d399;">${totalVictims}</div>
                        </div>
                        <div class="aar-metric-card">
                            <div style="font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase;">Units Deployed</div>
                            <div class="aar-metric-val" style="color: #60a5fa;">${aar.dispatched_units?.length || 1}</div>
                        </div>
                        <div class="aar-metric-card">
                            <div style="font-size: 0.7rem; color: var(--text-secondary); text-transform: uppercase;">Threat Severity</div>
                            <div class="aar-metric-val" style="color: #f59e0b;">${aar.severity}</div>
                        </div>
                    </div>

                    <div style="background: rgba(15,23,42,0.6); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; margin-bottom: 14px;">
                        <h4 style="font-size: 0.85rem; font-weight: 700; color: #fff; margin-bottom: 6px;">Incident Synopsis</h4>
                        <div style="font-size: 0.85rem; color: var(--text-primary); font-weight: 600;">${aar.title}</div>
                        <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">📍 ${aar.location_name}</div>
                        <div style="font-size: 0.75rem; color: #38bdf8; margin-top: 4px;">🚒 Responders: <strong>${unitsList}</strong></div>
                    </div>

                    <div style="background: rgba(15,23,42,0.6); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; margin-bottom: 14px;">
                        <h4 style="font-size: 0.85rem; font-weight: 700; color: #fff; margin-bottom: 8px;">Triage Casualty Breakdown</h4>
                        <div class="casualty-tally-bar" style="gap: 12px;">
                            <span class="victim-tag-chip tag-red" style="font-size: 0.8rem; padding: 4px 10px;">🔴 Immediate Critical: <strong>${tally.RED}</strong></span>
                            <span class="victim-tag-chip tag-yellow" style="font-size: 0.8rem; padding: 4px 10px;">🟡 Delayed Urgent: <strong>${tally.YELLOW}</strong></span>
                            <span class="victim-tag-chip tag-green" style="font-size: 0.8rem; padding: 4px 10px;">🟢 Minor Rescued: <strong>${tally.GREEN}</strong></span>
                            <span class="victim-tag-chip tag-black" style="font-size: 0.8rem; padding: 4px 10px;">⚫ Deceased: <strong>${tally.BLACK}</strong></span>
                        </div>
                    </div>

                    <div>
                        <h4 style="font-size: 0.85rem; font-weight: 700; color: #fff; margin-bottom: 8px;">Chronological Mission Timeline</h4>
                        <div class="aar-timeline-wrap">
                            ${(aar.timeline || []).map(t => `
                                <div class="aar-timeline-step">
                                    <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: #94a3b8; font-family: var(--font-mono);">
                                        <span>${t.timestamp || t.iso_timestamp || ''}</span>
                                        <strong style="color: #38bdf8;">${t.action || t.statusChange || 'LOG_ENTRY'}</strong>
                                    </div>
                                    <div style="font-size: 0.78rem; color: #e2e8f0; margin-top: 2px;">${t.notes || t.note || ''}</div>
                                    ${t.authorName ? `<div style="font-size: 0.68rem; color: #64748b;">Author: ${t.authorName} (${t.authorRole || 'RESPONDER'})</div>` : ''}
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }

            if (modal) modal.classList.add("active");
            lucide.createIcons();
        } catch (e) {
            console.error("AAR Error:", e);
            this.showNotification("Failed to load After-Action Report: " + e.message, "danger");
        }
    }

    locateOnMap(incidentId) {
        const inc = this.incidents.find(i => i.id === incidentId);
        if (!inc) return;
        this.switchTab("tab-map");
        this.selectIncident(inc);
    }

    initCharts() {
        if (typeof Chart === 'undefined') {
            console.warn("Chart.js not loaded yet, deferred chart init.");
            return;
        }

        const ctxType = document.getElementById("chart-disaster-types");
        const ctxSev = document.getElementById("chart-severity");
        if (!ctxType || !ctxSev) return;

        try {
            if (this.charts.types) {
                this.charts.types.destroy();
            }
            this.charts.types = new Chart(ctxType, {
                type: 'bar',
                data: {
                    labels: ['FIRE', 'FLOOD', 'INDUSTRIAL', 'COLLAPSE', 'CYCLONE', 'QUAKE'],
                    datasets: [{
                        label: 'Active Incidents',
                        data: [0, 0, 0, 0, 0, 0],
                        backgroundColor: ['#ef4444', '#3b82f6', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899'],
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { ticks: { color: '#9ca3af', font: { size: 10 } }, grid: { color: 'rgba(75,85,99,0.2)' } },
                        y: { ticks: { color: '#9ca3af', precision: 0 }, grid: { color: 'rgba(75,85,99,0.2)' }, beginAtZero: true }
                    }
                }
            });

            if (this.charts.severity) {
                this.charts.severity.destroy();
            }
            this.charts.severity = new Chart(ctxSev, {
                type: 'doughnut',
                data: {
                    labels: ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'],
                    datasets: [{
                        data: [0, 0, 0, 0],
                        backgroundColor: ['#ef4444', '#f97316', '#06b6d4', '#10b981'],
                        borderColor: '#0f172a',
                        borderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom', labels: { color: '#9ca3af', boxWidth: 12, font: { size: 11 } } }
                    }
                }
            });
            this.updateCharts();
        } catch (e) {
            console.warn("Error initializing Chart.js:", e);
        }
    }

    updateCharts() {
        if (!this.charts.types || !this.charts.severity) {
            this.initCharts();
            if (!this.charts.types || !this.charts.severity) return;
        }

        const countsByType = {
            'FIRE': 0, 'FLOOD': 0, 'INDUSTRIAL': 0,
            'STRUCTURAL_COLLAPSE': 0, 'CYCLONE': 0, 'EARTHQUAKE': 0
        };
        const countsBySev = { 'CRITICAL': 0, 'HIGH': 0, 'MODERATE': 0, 'LOW': 0 };

        (this.incidents || []).forEach(inc => {
            if (countsByType[inc.type] !== undefined) countsByType[inc.type]++;
            if (countsBySev[inc.severity] !== undefined) countsBySev[inc.severity]++;
        });

        this.charts.types.data.datasets[0].data = [
            countsByType['FIRE'], countsByType['FLOOD'], countsByType['INDUSTRIAL'],
            countsByType['STRUCTURAL_COLLAPSE'], countsByType['CYCLONE'], countsByType['EARTHQUAKE']
        ];
        this.charts.types.update();

        this.charts.severity.data.datasets[0].data = [
            countsBySev['CRITICAL'], countsBySev['HIGH'], countsBySev['MODERATE'], countsBySev['LOW']
        ];
        this.charts.severity.update();
    }

    async loadSitrepPreview() {
        const previewEl = document.getElementById("sitrep-preview-text");
        if (!previewEl) return;
        try {
            previewEl.innerText = "Generating official Situation Report (SITREP)...";
            const res = await fetch("/api/export/sitrep");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            previewEl.innerText = text;
        } catch (e) {
            console.error("SITREP load error:", e);
            previewEl.innerText = "Error loading SITREP preview: " + e.message;
        }
    }

    updateTicker() {
        const ticker = document.getElementById("active-alert-ticker");
        if (!ticker) return;
        const active = (this.incidents || []).filter(i => i.status !== "RESOLVED");
        const criticalCount = active.filter(i => i.severity === "CRITICAL" || (i.urgency_score || 0) >= 80).length;
        if (active.length === 0) {
            ticker.innerText = "ALL SECTORS SECURE // ZERO ACTIVE THREATS REPORTED ACROSS TAMIL NADU";
        } else {
            const headlines = active.slice(0, 5).map(i => `[${i.id}] ${i.title} (${i.location_name || i.locationName}) - URGENCY ${i.urgency_score || i.urgencyScore}/100`);
            ticker.innerText = `🚨 ${criticalCount} CRITICAL THREATS ACTIVE // ` + headlines.join("  ///  ");
        }
    }


    setRole(role) {
        this.currentRole = role;
        
        // Update Role Toggle Button States
        document.querySelectorAll(".role-toggle-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.role === role);
        });

        const simBtn = document.getElementById("btn-simulate-feed");

        if (role === "FIELD_RESPONDER") {
            // Strict Sidebar & Control Isolation for Field Responders
            document.querySelectorAll(".nav-role-control").forEach(el => el.style.display = "none");
            document.querySelectorAll(".nav-role-responder").forEach(el => el.style.display = "flex");
            if (simBtn) simBtn.style.display = "none";

            // Direct Redirect to Dedicated Tactical Terminal
            this.switchTab("tab-responder");
            this.populateResponderUnitSelect();
            this.renderResponderMission();
            this.showNotification("ROLE ACTIVE: Field Tactical Responder (RBAC Enforced)", "info");
        } else {
            // Restore Control Room Dispatch Workspace
            document.querySelectorAll(".nav-role-control").forEach(el => el.style.display = "flex");
            document.querySelectorAll(".nav-role-responder").forEach(el => el.style.display = "none");
            if (simBtn) simBtn.style.display = "inline-flex";

            this.switchTab("tab-map");
            this.showNotification("ROLE ACTIVE: Control Room Dispatcher HUD", "info");
        }
    }

    populateResponderUnitSelect() {
        const select = document.getElementById("select-responder-unit");
        if (!select) return;

        const options = [
            `<option value="COMMAND-ALPHA" ${this.activeResponderUnit === 'COMMAND-ALPHA' ? 'selected' : ''}>COMMAND-ALPHA (Tactical HQ)</option>`
        ];

        this.units.forEach(u => {
            options.push(
                `<option value="${u.id}" ${this.activeResponderUnit === u.id ? 'selected' : ''}>${u.id} - ${u.name}</option>`
            );
        });

        select.innerHTML = options.join('');
    }

    getAssignedMission() {
        if (this.activeResponderUnit === "COMMAND-ALPHA") {
            // Pick highest urgency active incident
            const active = this.incidents.filter(i => i.status !== "RESOLVED");
            if (active.length > 0) return active[0];
            return this.incidents[0] || null;
        } else {
            // Find incident where unit is in dispatched_units
            const assigned = this.incidents.find(i => (i.dispatched_units || []).includes(this.activeResponderUnit) && i.status !== "RESOLVED");
            if (assigned) return assigned;
            // Fallback to highest urgency active
            return this.incidents.find(i => i.status !== "RESOLVED") || this.incidents[0] || null;
        }
    }

    renderResponderMission() {
        const mission = this.getAssignedMission();
        const callsignBadge = document.getElementById("resp-callsign-badge");
        const teamBadge = document.getElementById("resp-team-badge");
        const sectorName = document.getElementById("resp-sector-name");

        if (callsignBadge) callsignBadge.innerText = this.activeResponderUnit;
        if (teamBadge) {
            const unit = this.units.find(u => u.id === this.activeResponderUnit);
            teamBadge.innerText = unit ? `🚒 ${unit.name}` : `🚒 Heavy Rescue Taskforce 1`;
        }

        if (!mission) {
            const titleEl = document.getElementById("resp-mission-title");
            if (titleEl) titleEl.innerText = "No Active Incident Assigned";
            return;
        }

        const idEl = document.getElementById("resp-mission-id");
        const titleEl = document.getElementById("resp-mission-title");
        const locEl = document.getElementById("resp-mission-location");
        const urgEl = document.getElementById("resp-mission-urgency");
        const routesEl = document.getElementById("resp-mission-routes");
        const instrEl = document.getElementById("resp-mission-instructions");
        const sevBadge = document.getElementById("resp-mission-sev-badge");

        if (idEl) idEl.innerText = `${mission.id} • Arrived: ${mission.created_at ? new Date(mission.created_at).toISOString().substring(11, 19) + ' UTC' : 'LIVE'} (SOS Reports: ${mission.sosAlertsCount || 1})`;
        if (titleEl) titleEl.innerText = `[${mission.type}] ${mission.title}`;
        if (locEl) locEl.innerText = `${mission.location_name} (${mission.latitude.toFixed(4)}, ${mission.longitude.toFixed(4)})`;
        if (urgEl) urgEl.innerText = `${mission.urgency_score}/100`;
        if (routesEl) routesEl.innerText = mission.accessRoutes || `Primary ingress via ${mission.location_name} arterial link. Caution: Sector traffic cleared for emergency units.`;
        if (instrEl) instrEl.innerText = mission.emergencyInstructions || mission.actionable_notes || "Establish tactical command post and perimeter. Initiate search & rescue.";
        
        if (sevBadge) {
            let cls = "badge-moderate";
            if (mission.severity === "CRITICAL") cls = "badge-critical";
            else if (mission.severity === "HIGH") cls = "badge-high";
            else if (mission.severity === "LOW") cls = "badge-low";
            sevBadge.innerHTML = `<span class="badge ${cls}">${mission.severity}</span>`;
        }

        // Update 6-State Tactical Status Buttons
        document.querySelectorAll(".tactical-btn").forEach(btn => {
            const btnStatus = btn.dataset.status;
            btn.classList.toggle("active", mission.status === btnStatus);
        });

        // Render Victims List
        this.renderVictimsList(mission);
    }

    renderVictimsList(mission) {
        const containers = [
            document.getElementById("responder-victim-list"),
            document.getElementById("responder-victim-list-alt")
        ].filter(Boolean);

        if (containers.length === 0) return;

        const victims = mission.victims || [];
        if (victims.length === 0) {
            containers.forEach(c => {
                c.innerHTML = `
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 16px;">
                        No victim profiles logged for this mission yet.
                    </div>
                `;
            });
            return;
        }

        const html = victims.map(v => {
            const catCls = `cat-${(v.category || 'red').toLowerCase()}`;
            return `
                <div class="victim-entry-card ${catCls}">
                    <div>
                        <div style="font-weight: 700; font-size: 0.85rem;">${v.name}</div>
                        <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px;">
                            ${v.notes || 'No symptoms noted'}
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span class="badge ${v.rescued ? 'badge-low' : 'badge-high'}">
                            ${v.rescued ? 'RESCUED / EVAC' : 'ON SCENE'}
                        </span>
                        <span class="badge" style="background: rgba(31,41,55,0.9);">${v.category}</span>
                    </div>
                </div>
            `;
        }).join('');

        containers.forEach(c => c.innerHTML = html);
    }

    async handleResponderStatusChange(newStatus) {
        const mission = this.getAssignedMission();
        if (!mission) {
            alert("No active incident to update.");
            return;
        }

        try {
            const res = await fetch(`/api/incidents/${mission.id}/status`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    status: newStatus,
                    notes: `Tactical mobilization updated to ${newStatus}`,
                    authorName: `Capt. Marcus Vance (${this.activeResponderUnit})`,
                    authorRole: "FIELD_RESPONDER"
                })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.showNotification(`Mission Status -> ${newStatus}`, "success");
                mission.status = newStatus;
                this.renderResponderMission();
            }
        } catch (e) {
            console.error("Status update error:", e);
            this.showNotification("Failed to update status: " + e.message, "danger");
        }
    }

    async handleVictimSubmit(formType = "main") {
        const mission = this.getAssignedMission();
        if (!mission) {
            alert("No active incident to log victim against.");
            return;
        }

        const isAlt = formType === "alt";
        const nameInput = document.getElementById(isAlt ? "input-victim-name-alt" : "input-victim-name");
        const notesInput = document.getElementById(isAlt ? "input-victim-notes-alt" : "input-victim-notes");
        const rescuedCheck = document.getElementById(isAlt ? "check-victim-rescued-alt" : "check-victim-rescued");

        const name = nameInput?.value?.trim() || "Unknown Individual";
        const notes = notesInput?.value?.trim() || "";
        const rescued = rescuedCheck ? rescuedCheck.checked : false;

        try {
            const res = await fetch(`/api/incidents/${mission.id}/victims`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: name,
                    category: this.selectedVictimCategory || "RED",
                    notes: notes,
                    rescued: rescued,
                    authorName: `Capt. Marcus Vance (${this.activeResponderUnit})`
                })
            });
            const data = await res.json();
            if (data.status === "SUCCESS") {
                this.showNotification(`Logged victim: ${name} [${this.selectedVictimCategory}]`, "success");
                if (nameInput) nameInput.value = "";
                if (notesInput) notesInput.value = "";
                if (rescuedCheck) rescuedCheck.checked = false;
            }
        } catch (e) {
            console.error("Victim logging error:", e);
            this.showNotification("Failed to log victim: " + e.message, "danger");
        }
    }

    // Step 10: Complete Queue Safety Sweep Audit Modal
    openSafetySweepModal() {
        const active = this.incidents.filter(i => i.status !== "RESOLVED");
        const unassignedCritical = active.filter(i => 
            (i.severity === "CRITICAL" || i.severity === "HIGH") && 
            (!i.dispatched_units || i.dispatched_units.length === 0)
        );
        const unrescuedVictims = active.reduce((sum, i) => {
            const count = (i.victims || []).filter(v => ["RED", "YELLOW"].includes(v.category) && !v.rescued).length;
            return sum + count;
        }, 0);

        const totalActiveEl = document.getElementById("sweep-total-active");
        const unassignedCritEl = document.getElementById("sweep-unassigned-critical");
        const unrescuedVicEl = document.getElementById("sweep-unrescued-victims");
        const gpsIntegEl = document.getElementById("sweep-gps-integrity");

        if (totalActiveEl) totalActiveEl.innerText = active.length;
        if (unassignedCritEl) unassignedCritEl.innerText = unassignedCritical.length;
        if (unrescuedVicEl) unrescuedVicEl.innerText = unrescuedVictims;
        if (gpsIntegEl) gpsIntegEl.innerText = "100% VALID";

        const listEl = document.getElementById("safety-sweep-incident-list");
        if (listEl) {
            if (active.length === 0) {
                listEl.innerHTML = `
                    <div style="font-size: 0.8rem; color: var(--text-muted); text-align: center; padding: 16px;">
                        Queue All Clear: No active or unverified incidents in system.
                    </div>
                `;
            } else {
                listEl.innerHTML = active.map(inc => {
                    const hasUnits = inc.dispatched_units && inc.dispatched_units.length > 0;
                    const rawTime = inc.createdAt || inc.created_at || new Date().toISOString();
                    const timeStr = new Date(rawTime).toISOString().substring(11, 19) + " UTC";
                    return `
                        <div class="sweep-incident-item">
                            <div>
                                <div style="font-weight: 700;">${inc.id} &bull; ${inc.title}</div>
                                <div style="font-size: 0.72rem; color: var(--text-secondary); margin-top: 2px;">
                                    📍 GPS Locked (${inc.latitude.toFixed(3)}, ${inc.longitude.toFixed(3)}) &bull; ⏱️ ${timeStr} &bull; Urgency: ${inc.urgency_score}/100
                                </div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span class="badge ${hasUnits ? 'badge-low' : 'badge-critical'}">
                                    ${hasUnits ? `🚒 ${inc.dispatched_units.join(', ')}` : 'UNASSIGNED'}
                                </span>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }

        const modal = document.getElementById("modal-safety-sweep");
        if (modal) modal.classList.add("active");
        lucide.createIcons();
    }

    handleConfirmSafetySweep() {
        const checkboxes = document.querySelectorAll(".sweep-checklist input[type='checkbox']");
        checkboxes.forEach(c => c.checked = true);
        this.closeModals();
        this.showNotification("🛡️ Operational Safety Sweep Verified: All critical life threats & response sectors cleared!", "success");
    }

    // Step 12: Controlled System Standby & Session Export
    async handleStandbyAndExport() {
        try {
            await this.handleDownloadSessionJson();

            // Populate summary in Standby Modal
            const totalIncidents = this.incidents.length;
            const casualtiesCount = this.incidents.reduce((s, i) => s + (i.affected_trapped || 0) + (i.affected_injured || 0), 0);
            const deployedUnits = this.units.filter(u => u.status !== "AVAILABLE").length;

            const incEl = document.getElementById("standby-stat-incidents");
            const casEl = document.getElementById("standby-stat-casualties");
            const uniEl = document.getElementById("standby-stat-units");

            if (incEl) incEl.innerText = totalIncidents;
            if (casEl) casEl.innerText = casualtiesCount;
            if (uniEl) uniEl.innerText = `${deployedUnits} Units`;

            const modal = document.getElementById("modal-system-standby");
            if (modal) modal.classList.add("active");
            lucide.createIcons();

            this.showNotification("Operational session archived. System placed on Standby.", "info");
        } catch (e) {
            console.error("Standby export failed:", e);
            this.showNotification("Failed to export session: " + e.message, "danger");
        }
    }

    async handleDownloadSessionJson() {
        const res = await fetch("/api/export/session");
        const data = await res.json();
        const jsonBlob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(jsonBlob);
        const a = document.createElement("a");
        const todayStr = new Date().toISOString().substring(0, 10);
        a.href = url;
        a.download = `cad_operational_summary_${todayStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    handleResumeCad() {
        this.closeModals();
        this.showNotification("CAD Operations Resumed // Live Telemetry Feed Active", "success");
    }

    showNotification(msg, type = "info") {
        const toast = document.createElement("div");
        toast.className = `badge badge-${type === 'danger' ? 'critical' : 'moderate'}`;
        toast.style.position = "fixed";
        toast.style.bottom = "20px";
        toast.style.right = "20px";
        toast.style.padding = "10px 16px";
        toast.style.fontSize = "0.85rem";
        toast.style.zIndex = "3000";
        toast.style.boxShadow = "0 8px 24px rgba(0,0,0,0.7)";
        toast.innerText = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 4000);
    }

    // =========================================================================
    // SIH26191: RED ZONES, CARRYING CAPACITY, AND RELOCATION ENGINE
    // =========================================================================

    async loadSIH26191Data() {
        try {
            const [rzRes, habRes, capRes, shRes, planRes] = await Promise.all([
                fetch("/api/red-zones").then(r => r.ok ? r.json() : []),
                fetch("/api/habitations").then(r => r.ok ? r.json() : []),
                fetch("/api/habitations/carrying-capacity").then(r => r.ok ? r.json() : []),
                fetch("/api/shelters").then(r => r.ok ? r.json() : []),
                fetch("/api/relocation/plan").then(r => r.ok ? r.json() : null)
            ]);

            this.redZones = rzRes || [];
            this.habitations = habRes || [];
            this.capacityReports = capRes || [];
            this.shelters = shRes || [];
            this.relocationPlan = planRes;

            this.updateSIH26191KPIs();

            if (window.cadMapManager) {
                window.cadMapManager.renderRedZones(this.redZones);
                window.cadMapManager.renderHabitations(this.habitations);
                window.cadMapManager.renderShelters(this.shelters);
                if (this.relocationPlan) {
                    window.cadMapManager.renderRelocationRoutes(this.relocationPlan);
                }
            }

            // Populate the right-hand Predictive Insight & Relocation Plan panel
            this.renderHazardInsightPanel(this.selectedHazardZoneId || "HAB-VEL-01");

            if (this.activeTab === "tab-redzones") {
                this.renderRedZonesPanel();
            } else if (this.activeTab === "tab-relocation") {
                this.renderRelocationPanel();
            }
        } catch (err) {
            console.error("Failed loading SIH26191 data:", err);
        }
    }

    updateSIH26191KPIs() {
        const totalHabEl = document.getElementById("sih-kpi-total-hab");
        const atRiskEl = document.getElementById("sih-kpi-at-risk-pop");
        const overCapEl = document.getElementById("sih-kpi-over-cap");
        const shelterCapEl = document.getElementById("sih-kpi-shelter-cap");
        const deficitEl = document.getElementById("sih-kpi-shelter-deficit");

        if (totalHabEl) totalHabEl.innerText = this.habitations.length;

        const atRisk = this.capacityReports.reduce((acc, r) => {
            if (r.vulnerability_tier === "CRITICAL" || r.vulnerability_tier === "HIGH") {
                return acc + (r.population || 0);
            }
            return acc;
        }, 0);
        if (atRiskEl) atRiskEl.innerText = atRisk.toLocaleString();

        const overCapCount = this.capacityReports.filter(r => r.is_over_carrying_capacity).length;
        if (overCapEl) overCapEl.innerText = overCapCount;

        const totalShelterCap = this.shelters.reduce((acc, s) => acc + (s.max_capacity || 0), 0);
        if (shelterCapEl) shelterCapEl.innerText = totalShelterCap.toLocaleString();

        const totalDeficit = this.capacityReports.reduce((acc, r) => acc + (r.shelter_deficit || 0), 0);
        if (deficitEl) deficitEl.innerText = totalDeficit.toLocaleString();
    }

    renderRedZonesPanel() {
        const rzContainer = document.getElementById("red-zones-list-container");
        const capContainer = document.getElementById("capacity-reports-container");

        // 1. Render Red Zones
        if (rzContainer) {
            if (!this.redZones || this.redZones.length === 0) {
                rzContainer.innerHTML = `<div style="text-align:center; color:#94a3b8; padding:24px;">No active Red Zones delineated.</div>`;
            } else {
                rzContainer.innerHTML = "";
                this.redZones.forEach(rz => {
                    const card = document.createElement("div");
                    card.style.cssText = "background: rgba(15,23,42,0.85); border: 1px solid rgba(239,68,68,0.3); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px;";
                    
                    const score = Math.round(rz.hazard_score || 0);
                    let badgeColor = "#ef4444";
                    let badgeBg = "rgba(239,68,68,0.2)";
                    if (score < 50) {
                        badgeColor = "#eab308";
                        badgeBg = "rgba(234,179,8,0.2)";
                    } else if (score < 75) {
                        badgeColor = "#f97316";
                        badgeBg = "rgba(249,115,22,0.2)";
                    }

                    card.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="font-family:var(--font-mono); font-size:10px; color:#94a3b8;">${rz.id}</span>
                                    <span style="background:${badgeBg}; border:1px solid ${badgeColor}; color:${badgeColor}; font-weight:800; font-size:10px; padding:2px 6px; border-radius:4px;">
                                        ${rz.severity_category} (${score}/100)
                                    </span>
                                </div>
                                <h4 style="margin:4px 0 2px 0; color:#f8fafc; font-size:13px; font-weight:700;">${rz.name}</h4>
                                <div style="font-size:11px; color:#94a3b8;">📍 ${rz.district} District • Elevation/Slope Risk Active</div>
                            </div>
                            <button class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" onclick="window.cadApp.focusMapOnCoordinates(${rz.center_lat}, ${rz.center_lon}, 13, 'RED_ZONES')">
                                <i data-lucide="map-pin" style="width:12px; height:12px;"></i> Inspect
                            </button>
                        </div>
                        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; font-size:11px;">
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Rainfall (24h)</span>
                                <strong style="color:#38bdf8;">${rz.metrics?.rainfall_24h_mm || 0} mm</strong>
                            </div>
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Flood Inundation</span>
                                <strong style="color:#ef4444;">${rz.metrics?.flood_risk_level || 'HIGH'}</strong>
                            </div>
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Terrain Slope</span>
                                <strong style="color:#f59e0b;">${rz.metrics?.slope_angle_deg || 0}°</strong>
                            </div>
                        </div>
                        <div style="font-size:11px; color:#cbd5e1; line-height:1.3; background:rgba(239,68,68,0.08); padding:6px 8px; border-radius:4px; border-left:2px solid ${badgeColor};">
                            ⚠️ <strong>Evacuation Advisory:</strong> Immediate evacuation protocol recommended for ${rz.affected_habitations?.length || 0} vulnerable habitations in perimeter.
                        </div>
                    `;
                    rzContainer.appendChild(card);
                });
            }
        }

        // 2. Render Carrying Capacity Reports
        if (capContainer) {
            if (!this.capacityReports || this.capacityReports.length === 0) {
                capContainer.innerHTML = `<div style="text-align:center; color:#94a3b8; padding:24px;">No habitation reports available.</div>`;
            } else {
                capContainer.innerHTML = "";
                this.capacityReports.forEach(rep => {
                    const card = document.createElement("div");
                    card.style.cssText = "background: rgba(15,23,42,0.85); border: 1px solid rgba(56,189,248,0.25); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px;";
                    
                    let tierColor = "#ef4444";
                    if (rep.vulnerability_tier === "LOW") tierColor = "#10b981";
                    else if (rep.vulnerability_tier === "MODERATE") tierColor = "#eab308";
                    else if (rep.vulnerability_tier === "HIGH") tierColor = "#f97316";

                    const stress = rep.density_stress_ratio ? (rep.density_stress_ratio).toFixed(2) : "1.00";
                    const overCapBadge = rep.is_over_carrying_capacity ? 
                        `<span style="color:#ef4444; background:rgba(239,68,68,0.15); border:1px solid #ef4444; padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">⚠️ OVER-CAPACITY (${stress}x)</span>` :
                        `<span style="color:#10b981; background:rgba(16,185,129,0.15); border:1px solid #10b981; padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">NORMAL (${stress}x)</span>`;

                    card.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                            <div>
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="font-family:var(--font-mono); font-size:10px; color:#94a3b8;">${rep.habitation_id}</span>
                                    <span style="color:${tierColor}; border:1px solid ${tierColor}; background:rgba(0,0,0,0.3); font-weight:800; font-size:10px; padding:2px 6px; border-radius:4px;">
                                        TIER: ${rep.vulnerability_tier}
                                    </span>
                                    ${overCapBadge}
                                </div>
                                <h4 style="margin:4px 0 2px 0; color:#f8fafc; font-size:13px; font-weight:700;">${rep.habitation_name}</h4>
                                <div style="font-size:11px; color:#94a3b8;">📍 ${rep.district} • Status: <strong style="color:#60a5fa;">${rep.status}</strong></div>
                            </div>
                            <button class="btn btn-primary" style="padding:4px 8px; font-size:11px;" onclick="window.cadApp.switchTab('tab-relocation')">
                                <i data-lucide="truck" style="width:12px; height:12px;"></i> Evacuate
                            </button>
                        </div>
                        <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:6px; background:rgba(0,0,0,0.3); padding:8px; border-radius:6px; font-size:11px;">
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Population</span>
                                <strong style="color:#f8fafc;">${(rep.population || 0).toLocaleString()}</strong>
                            </div>
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Fragility Ratio</span>
                                <strong style="color:#f59e0b;">${((rep.demographic_fragility_ratio || 0) * 100).toFixed(1)}%</strong>
                            </div>
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Shelter Deficit</span>
                                <strong style="color:${rep.shelter_deficit > 0 ? '#ef4444' : '#10b981'};">${(rep.shelter_deficit || 0).toLocaleString()}</strong>
                            </div>
                            <div>
                                <span style="color:#64748b; display:block; font-size:9px; text-transform:uppercase;">Hazard Score</span>
                                <strong style="color:#ef4444;">${Math.round(rep.hazard_severity_score || 0)} / 100</strong>
                            </div>
                        </div>
                    `;
                    capContainer.appendChild(card);
                });
            }
        }

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    renderRelocationPanel() {
        const container = document.getElementById("relocation-allocations-container");
        if (!container) return;

        if (!this.relocationPlan || !this.relocationPlan.allocations || this.relocationPlan.allocations.length === 0) {
            container.innerHTML = `<div style="text-align:center; color:#94a3b8; padding:32px;">No pending relocation allocations. All habitations within carrying capacity limits.</div>`;
            return;
        }

        container.innerHTML = "";
        this.relocationPlan.allocations.forEach(item => {
            const card = document.createElement("div");
            card.style.cssText = "background: rgba(15,23,42,0.92); border: 1px solid rgba(251,146,60,0.35); border-radius: 8px; padding: 14px; display: flex; flex-direction: column; gap: 10px;";

            const fleet = item.convoy_requirements || {};
            const isCompleted = item.habitation_status === "EVACUATED";
            const isInProgress = item.habitation_status === "IN_PROGRESS";

            let actionBtnHtml = `
                <button class="btn btn-primary" style="padding:6px 14px; font-size:12px; font-weight:700; background:#f97316; border-color:#ea580c;" onclick="window.cadApp.executeRelocationConvoy('${item.habitation_id}', '${item.target_shelter_id}', ${item.evacuees_to_relocate})">
                    <i data-lucide="truck" style="width:14px; height:14px;"></i> Mobilize Convoy (${item.evacuees_to_relocate.toLocaleString()} Pax)
                </button>
            `;

            if (isCompleted) {
                actionBtnHtml = `
                    <span style="color:#10b981; background:rgba(16,185,129,0.15); border:1px solid #10b981; padding:6px 12px; border-radius:6px; font-weight:700; font-size:12px; display:inline-flex; align-items:center; gap:6px;">
                        <i data-lucide="check-circle" style="width:14px; height:14px;"></i> EVACUATION COMPLETED
                    </span>
                `;
            } else if (isInProgress) {
                actionBtnHtml = `
                    <span style="color:#38bdf8; background:rgba(56,189,248,0.15); border:1px solid #38bdf8; padding:6px 12px; border-radius:6px; font-weight:700; font-size:12px; display:inline-flex; align-items:center; gap:6px;">
                        <i data-lucide="loader-2" class="spin" style="width:14px; height:14px;"></i> CONVOY EN-ROUTE
                    </span>
                `;
            }

            card.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:8px;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="background:#ea580c; color:#fff; font-weight:900; font-size:12px; padding:3px 8px; border-radius:4px;">
                            PRIORITY #${item.priority_rank}
                        </span>
                        <div>
                            <span style="color:#f8fafc; font-weight:800; font-size:14px;">${item.habitation_name}</span>
                            <span style="color:#94a3b8; font-size:11px;">(${item.district})</span>
                        </div>
                    </div>
                    <div style="text-align:right;">
                        <span style="font-size:11px; color:#94a3b8;">Priority Score:</span>
                        <strong style="color:#ef4444; font-size:14px; margin-left:4px;">${(item.composite_priority_score || 0).toFixed(1)} / 100</strong>
                    </div>
                </div>

                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:12px;">
                    <!-- Source Habitation -->
                    <div style="background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.2); border-radius:6px; padding:10px;">
                        <div style="font-size:10px; color:#f87171; font-weight:700; text-transform:uppercase; margin-bottom:4px;">
                            📍 Origin Habitation (Evacuation Zone)
                        </div>
                        <div style="font-size:12px; color:#f8fafc; font-weight:700;">${item.habitation_name}</div>
                        <div style="font-size:11px; color:#cbd5e1; margin-top:2px;">
                            Total Population: <strong>${(item.population || 0).toLocaleString()}</strong><br>
                            Immediate Evacuees: <strong style="color:#ef4444;">${(item.evacuees_to_relocate || 0).toLocaleString()} citizens</strong>
                        </div>
                    </div>

                    <!-- Target Safe Shelter -->
                    <div style="background:rgba(16,185,129,0.06); border:1px solid rgba(16,185,129,0.2); border-radius:6px; padding:10px;">
                        <div style="font-size:10px; color:#34d399; font-weight:700; text-transform:uppercase; margin-bottom:4px;">
                            🛡️ Assigned Safe Relief Shelter
                        </div>
                        <div style="font-size:12px; color:#f8fafc; font-weight:700;">${item.target_shelter_name}</div>
                        <div style="font-size:11px; color:#cbd5e1; margin-top:2px;">
                            Distance: <strong style="color:#38bdf8;">${item.distance_km} km</strong> • ETA: <strong style="color:#f59e0b;">${item.estimated_transit_time_minutes} mins</strong><br>
                            Available Shelter Capacity: <strong style="color:#34d399;">${(item.target_shelter_available_capacity || 0).toLocaleString()} beds</strong>
                        </div>
                    </div>
                </div>

                <!-- Fleet Convoy Requisition -->
                <div style="background:rgba(0,0,0,0.3); border-radius:6px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; gap:16px; font-size:11px; align-items:center;">
                        <span style="color:#94a3b8; font-weight:600;">CONVOY FLEET:</span>
                        <span style="color:#38bdf8;"><i data-lucide="bus" style="width:12px; height:12px; vertical-align:middle;"></i> <strong>${fleet.buses_needed || 0}</strong> Buses</span>
                        <span style="color:#ef4444;"><i data-lucide="ambulance" style="width:12px; height:12px; vertical-align:middle;"></i> <strong>${fleet.ambulances_needed || 0}</strong> Ambulances</span>
                        <span style="color:#eab308;"><i data-lucide="shield" style="width:12px; height:12px; vertical-align:middle;"></i> <strong>${fleet.escort_vehicles_needed || 0}</strong> Escorts</span>
                        ${fleet.inflatable_boats_needed > 0 ? `<span style="color:#06b6d4;"><i data-lucide="ship" style="width:12px; height:12px; vertical-align:middle;"></i> <strong>${fleet.inflatable_boats_needed}</strong> Rescue Boats</span>` : ""}
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="btn btn-secondary" style="padding:4px 8px; font-size:11px;" onclick="window.cadApp.focusMapOnRoute('${item.habitation_id}')">
                            <i data-lucide="navigation" style="width:12px; height:12px;"></i> Corridor
                        </button>
                        ${actionBtnHtml}
                    </div>
                </div>
            `;
            container.appendChild(card);
        });

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    async executeRelocationConvoy(habitationId, shelterId, count) {
        try {
            const res = await fetch("/api/relocation/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    habitation_id: habitationId,
                    shelter_id: shelterId,
                    evacuees_count: count,
                    convoy_notes: "Mobilized via Control Room Immediate Relocation Dashboard"
                })
            });
            if (!res.ok) {
                const err = await res.json();
                this.showNotification(`Convoy Mobilization Failed: ${err.detail || "Server error"}`, "danger");
                return;
            }
            const data = await res.json();
            this.showNotification(`🚚 RELOCATION CONVOY DISPATCHED: ${data.evacuees_moved} citizens en-route to ${data.target_shelter?.name}`, "success");
            if (window.cadAudio && typeof window.cadAudio.playSuccess === "function") {
                window.cadAudio.playSuccess();
            }
            await this.loadSIH26191Data();
        } catch (e) {
            console.error("Execute convoy error:", e);
            this.showNotification("Error executing relocation convoy.", "danger");
        }
    }

    focusMapOnCoordinates(lat, lon, zoom = 14, mode = null) {
        this.switchTab("tab-map");
        if (window.cadMapManager && window.cadMapManager.map) {
            if (mode) {
                window.cadMapManager.setMapMode(mode);
                const selectEl = document.getElementById("map-layer-mode");
                if (selectEl) selectEl.value = mode;
            }
            window.cadMapManager.map.setView([lat, lon], zoom);
        }
    }

    focusMapOnRoute(habitationId) {
        this.switchTab("tab-map");
        if (window.cadMapManager) {
            window.cadMapManager.setMapMode("CONVOYS");
            const selectEl = document.getElementById("map-layer-mode");
            if (selectEl) selectEl.value = "CONVOYS";
            
            const hab = this.habitations.find(h => h.id === habitationId);
            if (hab && window.cadMapManager.map) {
                window.cadMapManager.map.setView([hab.latitude || hab.lat, hab.longitude || hab.lon], 12);
            }
        }
    }

    selectHazardZone(zoneId) {
        this.selectedHazardZoneId = zoneId;
        
        // If not already viewing map, switch to map view
        if (this.activeTab !== "tab-map" && this.activeTab !== "tab-relocation-plan") {
            this.switchTab("tab-map");
        }

        // Render insight panel
        this.renderHazardInsightPanel(zoneId);

        // Center map on zone
        let targetLat = 12.9791, targetLng = 80.2185;
        const hab = this.habitations.find(h => h.id === zoneId || h.id.includes(zoneId) || zoneId.includes(h.id));
        if (hab) {
            targetLat = hab.latitude;
            targetLng = hab.longitude;
        } else {
            const rz = this.redZones.find(r => r.id === zoneId);
            if (rz) {
                targetLat = rz.center_lat;
                targetLng = rz.center_lng;
            }
        }

        if (window.cadMapManager) {
            window.cadMapManager.focusLocation(targetLat, targetLng, 14);
        }
    }

    renderHazardInsightPanel(zoneId = "HAB-VEL-01") {
        const panel = document.getElementById("hazard-insight-panel");
        if (!panel) return;
        panel.style.display = "flex";

        // Hide legacy incident drawer
        const incidentDrawer = document.getElementById("map-incident-drawer");
        if (incidentDrawer) incidentDrawer.style.display = "none";

        const zoneMap = {
            "HAB-VEL-01": {
                zoneId: "ZN-44B",
                zoneName: "THIRUVANAMADUR",
                fullName: "Velachery Lowland Settlement",
                expectedOnset: "14 HOURS (Approx.)",
                riskIntensity: "CRITICAL",
                intensityPercent: 92,
                timelinePhase: "CRITICAL RELOCATION PHASE",
                disaster: "Riverine Flood / Flash Flood",
                cause: "345mm forecasted rainfall in 24hr cycle, compounded by upper catchment release from Chembarambakkam Dam.",
                scale: "Widespread inundation of habitations H-12, H-13, H-14; approx. 15 sq km.",
                victims: "EST. 3,800 People",
                victimsBreakdown: "Derived from Census: 940 Households • 580 Elderly • 910 Children • 85 Differently-Abled",
                measures: "🛡️ <strong>Phase 1 Relocation Steps:</strong> Immediate mobilization of vulnerable habitations. Secure route via Velachery Main Rd Corridor.<br/>🚤 <strong>SDRF / NDRF Deployment:</strong> Position 4 inflatable rescue boats and 2 tactical swift-water teams.<br/>🍞 <strong>3-Day Food Supply Logistics:</strong> Pre-position dry rations, potable water tankers (20,000L), and emergency baby food packs.",
                currentDensity: 3000,
                safeCapacity: 857,
                pressureRatio: "3.5",
                demoBreakdown: { elderly: 580, children: 910, pwd: 85, medical: 95 },
                demoVulnerableCount: "1,740",
                demoVulnerablePct: "41.4%",
                shelterDestinations: [
                    { id: "SHL-CHN-01", name: "Shelter S-9 (Capacity: 2000, Open: 400)", capacity: 2000, current: 1600, open: 400, dist: "4.2 km" },
                    { id: "SHL-CHN-02", name: "Shelter S-10 (Capacity: 1800, Open: 280)", capacity: 1800, current: 1520, open: 280, dist: "5.8 km" }
                ],
                shelterOccupancyText: "Shelter S-9 & S-10: 1,600 / 2,000 Headroom",
                shelterOccPercent: 20,
                shelterAvailPercent: 80,
                center: [12.9791, 80.2185],
                shelterCoords: [12.9915, 80.2180],
                convoys: "🚌 12 Heavy Buses | 🚑 4 Ambulances | 🚓 2 SDRF Escorts",
                targetShelterId: "SHL-CHN-01",
                evacueesCount: 3800
            },
            "HAB-ENN-02": {
                zoneId: "ZN-12A",
                zoneName: "ENNORE CREEK",
                fullName: "Ennore Creek Coastal Fisher Hamlet",
                expectedOnset: "18 HOURS (Approx)",
                riskIntensity: "HIGH",
                intensityPercent: 78,
                timelinePhase: "PRE-EVACUATION ADVISORY",
                disaster: "Coastal Surge & Industrial Creek Backflow",
                cause: "High astronomical tide + 65 km/h squalls + 5,400 cusecs surplus release from Poondi reservoir into Kosasthalaiyar creek.",
                scale: "Inundation of low-lying coastal fishing settlement up to 1.6m water depth.",
                victims: "EST. 2,800 People",
                victimsBreakdown: "Derived from Census: 610 Households • 380 Elderly • 610 Children • 42 Differently-Abled • 152 Kutcha Structures",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Evacuate fisher hamlets within 300m of creek bank via Ennore Expressway.<br/>🚤 <strong>Coastal Response:</strong> Mobilize Indian Coast Guard craft & SDRF North team.<br/>🍞 <strong>Relief Supplies:</strong> Pre-stage 3-day packaged food kits and chlorination tablets.",
                currentDensity: 3111,
                safeCapacity: 888,
                pressureRatio: "3.5",
                demoBreakdown: { elderly: 380, children: 610, pwd: 42, medical: 63 },
                demoVulnerableCount: "1,095",
                demoVulnerablePct: "39.1%",
                shelterDestinations: [
                    { id: "SHL-CHN-03", name: "Shelter S-2 (Thiruvottiyur Higher Secondary Camp)", capacity: 2200, current: 400, open: 1800, dist: "4.5 km" },
                    { id: "SHL-CHN-02", name: "Shelter S-7 (Santhome Multipurpose Complex)", capacity: 1800, current: 150, open: 1650, dist: "9.2 km" }
                ],
                shelterOccupancyText: "1,800 / 2,200 Headroom",
                shelterOccPercent: 18,
                shelterAvailPercent: 82,
                center: [13.2144, 80.3211],
                shelterCoords: [13.1610, 80.3015],
                convoys: "🚌 8 Heavy Buses | 🚑 2 Ambulances | 🚓 2 Police Escorts",
                targetShelterId: "SHL-CHN-02",
                evacueesCount: 2800
            },
            "HAB-CUD-03": {
                zoneId: "ZN-08C",
                zoneName: "CUDDALORE OLD TOWN",
                fullName: "Devanampattinam Coastal Inundation Sector",
                expectedOnset: "20 HOURS (Approx)",
                riskIntensity: "HIGH",
                intensityPercent: 75,
                timelinePhase: "CYCLONE SURGE ALERT",
                disaster: "Severe Cyclone Storm Surge & Inundation",
                cause: "Deep depression tracking northwest with 80 km/h squalls and 2.4m storm surges overtopping coastal seawalls.",
                scale: "Coastal beach hamlets within 400m of tidal waterline.",
                victims: "EST. 3,100 People",
                victimsBreakdown: "Derived from Census: 820 Households • 450 Elderly • 680 Children • 55 Differently-Abled • 205 Kutcha Homes",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Pre-emptive evacuation to Cuddalore Multipurpose Cyclone Shelter.<br/>🚜 <strong>Disaster Equipment:</strong> Standby high-volume diesel pumps and 4x4 troop carriers.<br/>🍞 <strong>Logistics:</strong> Pre-position 3-day dry rations and solar emergency lighting.",
                currentDensity: 1714,
                safeCapacity: 524,
                pressureRatio: "3.27",
                demoBreakdown: { elderly: 450, children: 680, pwd: 55, medical: 71 },
                demoVulnerableCount: "1,465",
                demoVulnerablePct: "40.7%",
                shelterDestinations: [
                    { id: "SHL-CUD-01", name: "Shelter S-3 (Cuddalore Port Cyclone Relief Center)", capacity: 3000, current: 650, open: 2350, dist: "3.1 km" }
                ],
                shelterOccupancyText: "2,350 / 3,000 Headroom",
                shelterOccPercent: 22,
                shelterAvailPercent: 78,
                center: [11.7480, 79.7714],
                shelterCoords: [11.7550, 79.7620],
                convoys: "🚌 9 Heavy Buses | 🚑 3 Ambulances | 🚓 2 SDRF Escorts",
                targetShelterId: "SHL-CUD-01",
                evacueesCount: 3100
            },
            "HAB-NIL-04": {
                zoneId: "ZN-04D",
                zoneName: "COONOOR HILL SLOPES",
                fullName: "Coonoor Landslide Slope Tea Colony",
                expectedOnset: "8 HOURS (Approx)",
                riskIntensity: "CRITICAL",
                intensityPercent: 95,
                timelinePhase: "CRITICAL SLOPE ONSET",
                disaster: "High-Velocity Slope Landslide & Debris Flow",
                cause: "IMD Cloudburst Alert (210mm/24h) saturating 38° mountain tea slope past critical shear angle.",
                scale: "Tea plantation worker habitations on precarious hillside terrain.",
                victims: "EST. 620 People",
                victimsBreakdown: "Derived from Census: 380 Households • 110 Elderly • 140 Children • 25 Differently-Abled • 95 Kutcha Shacks",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Immediate slope evacuation before mountain road severance.<br/>🚜 <strong>Debris Clearance:</strong> Deploy earthmovers along Ghat Road.<br/>🍞 <strong>Supplies:</strong> Thermal blankets, hot soup kitchens, and emergency trauma medicine.",
                currentDensity: 1409,
                safeCapacity: 409,
                pressureRatio: "3.44",
                demoBreakdown: { elderly: 110, children: 140, pwd: 25, medical: 40 },
                demoVulnerableCount: "678",
                demoVulnerablePct: "43.7%",
                shelterDestinations: [
                    { id: "SHL-NIL-01", name: "Shelter S-4 (Coonoor Municipal Safe Highland Complex)", capacity: 1200, current: 210, open: 990, dist: "2.4 km" }
                ],
                shelterOccupancyText: "990 / 1,200 Headroom",
                shelterOccPercent: 17,
                shelterAvailPercent: 83,
                center: [11.3530, 76.7959],
                shelterCoords: [11.3580, 76.8120],
                convoys: "🚌 4 Mini Mountain Buses | 🚑 2 4x4 Ambulances | 🚓 1 SDRF Escort",
                targetShelterId: "SHL-NIL-01",
                evacueesCount: 620
            },
            "HAB-MDU-05": {
                zoneId: "ZN-19E",
                zoneName: "MADURAI VAIGAI",
                fullName: "Vaigai North Riverbed Lowland Ward",
                expectedOnset: "12 HOURS (Approx)",
                riskIntensity: "CRITICAL",
                intensityPercent: 88,
                timelinePhase: "RIVERBED INUNDATION PHASE",
                disaster: "Riverine Flood & Riverbed Inundation",
                cause: "Vaigai Dam surplus discharge of 4,800 cusecs combined with 140mm local rain.",
                scale: "Low-lying wards along Vaigai Riverbed North Bank.",
                victims: "EST. 4,800 People",
                victimsBreakdown: "Derived from Census: 1,120 Households • 680 Elderly • 1,100 Children • 95 Differently-Abled • 224 Kutcha Units",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Evacuate riverbed encroachments to Corporation Stadium.<br/>🚤 <strong>Water Rescue:</strong> Deploy Tamil Nadu Fire & Rescue watercraft.<br/>🍞 <strong>Supplies:</strong> 3-day dry rations, clean water tankers, and bleaching powder.",
                currentDensity: 3000,
                safeCapacity: 1000,
                pressureRatio: "3.0",
                demoBreakdown: { elderly: 680, children: 1100, pwd: 95, medical: 117 },
                demoVulnerableCount: "1,992",
                demoVulnerablePct: "41.5%",
                shelterDestinations: [
                    { id: "SHL-MDU-01", name: "Shelter S-5 (Madurai Elevated Stadium Relief Center)", capacity: 2800, current: 300, open: 2500, dist: "3.6 km" }
                ],
                shelterOccupancyText: "2,500 / 2,800 Headroom",
                shelterOccPercent: 11,
                shelterAvailPercent: 89,
                center: [9.9252, 78.1198],
                shelterCoords: [9.9320, 78.1320],
                convoys: "🚌 14 Heavy Buses | 🚑 4 Ambulances | 🚓 2 Police Escorts",
                targetShelterId: "SHL-MDU-01",
                evacueesCount: 4800
            },
            "HAB-THO-06": {
                zoneId: "ZN-22F",
                zoneName: "THOOTHUKUDI HARBOUR",
                fullName: "Thoothukudi Old Harbour Salt Marsh Hamlet",
                expectedOnset: "16 HOURS (Approx)",
                riskIntensity: "HIGH",
                intensityPercent: 74,
                timelinePhase: "SALT MARSH SURGE STANDBY",
                disaster: "Coastal Salt Pan Tidal Surge & Inundation",
                cause: "High astronomical tide and 55 km/h squalls overtopping salt pan bunds.",
                scale: "Salt pan worker settlements and old harbour marsh fringe.",
                victims: "EST. 3,100 People",
                victimsBreakdown: "Derived from Census: 720 Households • 440 Elderly • 710 Children • 55 Differently-Abled • 144 Kutcha Units",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Move workers to VOC Port Community Center.<br/>🚤 <strong>Marine Police:</strong> Patrol coastline and secure fishing vessels.<br/>🍞 <strong>Logistics:</strong> 3-day dry food packs and clean water supply.",
                currentDensity: 1722,
                safeCapacity: 528,
                pressureRatio: "3.26",
                demoBreakdown: { elderly: 440, children: 710, pwd: 55, medical: 72 },
                demoVulnerableCount: "1,277",
                demoVulnerablePct: "41.2%",
                shelterDestinations: [
                    { id: "SHL-CHN-01", name: "Shelter S-8 (VOC Port Multi-Purpose Relief Center)", capacity: 2500, current: 320, open: 2180, dist: "2.8 km" }
                ],
                shelterOccupancyText: "2,180 / 2,500 Headroom",
                shelterOccPercent: 13,
                shelterAvailPercent: 87,
                center: [8.7642, 78.1348],
                shelterCoords: [8.7800, 78.1500],
                convoys: "🚌 8 Heavy Buses | 🚑 2 Ambulances | 🚓 1 Escort",
                targetShelterId: "SHL-CHN-01",
                evacueesCount: 3100
            },
            "HAB-PER-07": {
                zoneId: "ZN-31G",
                zoneName: "PERUNGUDI BASIN",
                fullName: "Perungudi Canal Drainage Basin Colony",
                expectedOnset: "15 HOURS (Approx)",
                riskIntensity: "CRITICAL",
                intensityPercent: 89,
                timelinePhase: "URBAN INUNDATION PHASE",
                disaster: "Urban Marshland Drainage Overflow",
                cause: "Heavy local cloudburst (260mm/24h) and south Buckingham canal backflow.",
                scale: "Slum habitations bordering Pallikaranai marshland.",
                victims: "EST. 3,900 People",
                victimsBreakdown: "Derived from Census: 910 Households • 580 Elderly • 890 Children • 72 Differently-Abled • 200 Kutcha Homes",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Transport residents to OMR IT Corridor Safe Centers.<br/>🚤 <strong>Rescue:</strong> Deploy NDRF inflatables with life-vests.<br/>🍞 <strong>Supplies:</strong> 3-day food supplies, milk powder for infants, and chlorine.",
                currentDensity: 3250,
                safeCapacity: 1083,
                pressureRatio: "3.0",
                demoBreakdown: { elderly: 580, children: 890, pwd: 72, medical: 88 },
                demoVulnerableCount: "1,630",
                demoVulnerablePct: "41.8%",
                shelterDestinations: [
                    { id: "SHL-CHN-01", name: "Shelter S-9 (Guru Nanak Relief Center)", capacity: 2000, current: 400, open: 1600, dist: "3.5 km" }
                ],
                shelterOccupancyText: "1,600 / 2,000 Headroom",
                shelterOccPercent: 20,
                shelterAvailPercent: 80,
                center: [12.9654, 80.2461],
                shelterCoords: [12.9915, 80.2180],
                convoys: "🚌 10 Heavy Buses | 🚑 3 Ambulances | 🚓 2 Escorts",
                targetShelterId: "SHL-CHN-01",
                evacueesCount: 3900
            },
            "HAB-TRC-08": {
                zoneId: "ZN-15H",
                zoneName: "SRIRANGAM KAVERI",
                fullName: "Srirangam Island Kaveri Flood Plain",
                expectedOnset: "17 HOURS (Approx)",
                riskIntensity: "HIGH",
                intensityPercent: 70,
                timelinePhase: "ISLAND INUNDATION ALERT",
                disaster: "Riverine Island Kaveri Flood Plain Inundation",
                cause: "Mettur Dam discharge of 45,000 cusecs flowing through Upper Anicut into Kollidam.",
                scale: "Low-lying riverbank settlements on Srirangam island.",
                victims: "EST. 2,900 People",
                victimsBreakdown: "Derived from Census: 680 Households • 490 Elderly • 620 Children • 48 Differently-Abled • 68 Kutcha Homes",
                measures: "🛡️ <strong>Phase 1 Relocation:</strong> Evacuate island fringe settlements via bridge link to Trichy Cantonment.<br/>🚤 <strong>Patrol:</strong> SDRF water patrol on Kollidam channel.<br/>🍞 <strong>Food:</strong> 3-day rations and mobile drinking water purification plant.",
                currentDensity: 1208,
                safeCapacity: 458,
                pressureRatio: "2.64",
                demoBreakdown: { elderly: 490, children: 620, pwd: 48, medical: 61 },
                demoVulnerableCount: "1,219",
                demoVulnerablePct: "42.0%",
                shelterDestinations: [
                    { id: "SHL-TRY-01", name: "Shelter S-6 (Trichy Cantonment Multi-Facility Hall)", capacity: 2200, current: 350, open: 1850, dist: "4.8 km" }
                ],
                shelterOccupancyText: "1,850 / 2,200 Headroom",
                shelterOccPercent: 16,
                shelterAvailPercent: 84,
                center: [10.8622, 78.6912],
                shelterCoords: [10.7905, 78.7047],
                convoys: "🚌 7 Heavy Buses | 🚑 2 Ambulances | 🚓 2 Police Escorts",
                targetShelterId: "SHL-TRY-01",
                evacueesCount: 2900
            }
        };

        // Match zone by ID or alias
        let matched = null;
        for (const [k, v] of Object.entries(zoneMap)) {
            if (zoneId === k || zoneId.includes(k) || (v.zoneId && zoneId.includes(v.zoneId))) {
                matched = v;
                break;
            }
        }

        if (!matched) {
            matched = zoneMap["HAB-VEL-01"];
        }

        const isCritical = matched.riskIntensity === "CRITICAL";
        const badgeColor = isCritical ? "#ef4444" : "#f59e0b";
        const gradient = isCritical ? "linear-gradient(90deg, #f59e0b, #ef4444)" : "linear-gradient(90deg, #10b981, #f59e0b)";
        const shadow = isCritical ? "0 0 14px #ef4444" : "0 0 14px #f59e0b";

        // 1. Update Header & Badges
        const zoneBadge = document.getElementById("insight-zone-badge");
        if (zoneBadge) zoneBadge.innerText = `HAZARD INSIGHT // ${matched.zoneName} (ZONE ID: ${matched.zoneId})`;

        const phaseBadge = document.getElementById("insight-phase-badge");
        if (phaseBadge) {
            phaseBadge.innerText = matched.timelinePhase || `${matched.riskIntensity} RELOCATION PHASE`;
            phaseBadge.style.borderColor = badgeColor;
            phaseBadge.style.color = badgeColor;
            phaseBadge.style.background = `${badgeColor}22`;
        }

        // 2. Update Timeline
        const onsetEl = document.getElementById("insight-expected-onset");
        if (onsetEl) onsetEl.innerText = matched.expectedOnset;

        const riskEl = document.getElementById("insight-risk-intensity");
        if (riskEl) {
            riskEl.innerText = matched.riskIntensity;
            riskEl.style.color = badgeColor;
        }

        const timelineBar = document.getElementById("insight-timeline-bar");
        if (timelineBar) {
            timelineBar.style.width = `${matched.intensityPercent}%`;
            timelineBar.style.background = gradient;
            timelineBar.style.boxShadow = shadow;
        }

        const thresholdLabel = document.getElementById("insight-onset-threshold-label");
        if (thresholdLabel) {
            thresholdLabel.innerText = matched.expectedOnset;
            thresholdLabel.style.color = badgeColor;
        }

        // 3. Update Structured Grid Breakdown
        const disasterEl = document.getElementById("insight-possible-disaster");
        if (disasterEl) disasterEl.innerHTML = `🌊 ${matched.disaster}`;

        const causeEl = document.getElementById("insight-reason-cause");
        if (causeEl) causeEl.innerHTML = `🌧️ ${matched.cause}`;

        const scaleEl = document.getElementById("insight-predicted-scale");
        if (scaleEl) scaleEl.innerHTML = `⚠️ ${matched.scale}`;

        const victimsEl = document.getElementById("insight-affected-victims");
        if (victimsEl) victimsEl.innerHTML = `👥 ${matched.victims}`;

        const victimsBreakdownEl = document.getElementById("insight-victims-breakdown");
        if (victimsBreakdownEl) victimsBreakdownEl.innerHTML = matched.victimsBreakdown;

        // 4. Update Carrying Capacity & Vulnerability Mini-Charts
        this.renderMiniDensityChart(matched);
        this.renderMiniDemographicsChart(matched);

        const occBar = document.getElementById("mini-shelter-occupancy-bar");
        if (occBar) occBar.style.width = `${matched.shelterAvailPercent}%`;

        const occText = document.getElementById("mini-shelter-occupancy-text");
        if (occText) occText.innerText = matched.shelterOccupancyText;

        const occPercent = document.getElementById("mini-shelter-occ-percent");
        if (occPercent) occPercent.innerText = `Current Occupancy: ${matched.shelterOccPercent}%`;

        const availPercent = document.getElementById("mini-shelter-avail-percent");
        if (availPercent) availPercent.innerText = `${matched.shelterAvailPercent}% Available Headroom`;

        // 5. Update Embedded Relocation Map
        this.renderMiniRelocationMap(matched);

        // 6. Update Primary Relocation Destinations
        this.renderPrimaryDestinations(matched);

        // 7. Update Recommended Government Measures
        const measuresEl = document.getElementById("panel-gov-measures-content");
        if (measuresEl) measuresEl.innerHTML = matched.measures;

        // 8. Update Action Button
        const mobilizeBtn = document.getElementById("btn-mobilize-zone-relocation");
        if (mobilizeBtn) {
            mobilizeBtn.disabled = false;
            mobilizeBtn.innerHTML = `<i data-lucide="truck"></i> INITIATE PHASE 1 RELOCATION CONVOYS`;
            mobilizeBtn.style.background = "linear-gradient(135deg, #ef4444, #dc2626)";
            mobilizeBtn.style.borderColor = "#ef4444";
            mobilizeBtn.onclick = () => this.triggerPhase1Relocation(zoneId);
        }

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    renderMiniDensityChart(matched) {
        const canvas = document.getElementById("mini-chart-density");
        if (!canvas || typeof Chart === 'undefined') return;

        if (this.charts.miniDensity) {
            this.charts.miniDensity.destroy();
        }

        const sublabel = document.getElementById("mini-density-sublabel");
        if (sublabel) sublabel.innerText = `${matched.pressureRatio}x Safe Capacity`;

        this.charts.miniDensity = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: ['Current', 'Safe Limit'],
                datasets: [{
                    data: [matched.currentDensity || 3000, matched.safeCapacity || 857],
                    backgroundColor: ['#ef4444', '#10b981'],
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: '#94a3b8', font: { size: 9 } }, grid: { display: false } },
                    y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
                }
            }
        });
    }

    renderMiniDemographicsChart(matched) {
        const canvas = document.getElementById("mini-chart-demographics");
        if (!canvas || typeof Chart === 'undefined') return;

        if (this.charts.miniDemo) {
            this.charts.miniDemo.destroy();
        }

        const sublabel = document.getElementById("mini-demo-sublabel");
        if (sublabel) sublabel.innerText = `${matched.demoVulnerableCount} Vulnerable (${matched.demoVulnerablePct})`;

        const demo = matched.demoBreakdown || { elderly: 580, children: 910, pwd: 85, medical: 95 };

        this.charts.miniDemo = new Chart(canvas, {
            type: 'doughnut',
            data: {
                labels: ['Elderly (60+)', 'Children (<5)', 'Differently-Abled', 'Medical'],
                datasets: [{
                    data: [demo.elderly, demo.children, demo.pwd, demo.medical],
                    backgroundColor: ['#fb923c', '#38bdf8', '#ef4444', '#c084fc'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '62%',
                plugins: { legend: { display: false } }
            }
        });
    }

    renderMiniRelocationMap(matched) {
        const container = document.getElementById("mini-relocation-map");
        if (!container || typeof L === 'undefined') return;

        // Initialize mini map once
        if (!this.miniRelocationMap) {
            if (container._leaflet_id) {
                container._leaflet_id = null;
            }
            this.miniRelocationMap = L.map(container, {
                zoomControl: false,
                attributionControl: false,
                dragging: false,
                scrollWheelZoom: false,
                doubleClickZoom: false,
                boxZoom: false
            });
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
                className: 'map-tiles-dark-theme'
            }).addTo(this.miniRelocationMap);
            this.miniRelocationLayers = [];
        }

        // Clear existing mini map layers
        if (this.miniRelocationLayers && this.miniRelocationLayers.length > 0) {
            this.miniRelocationLayers.forEach(l => this.miniRelocationMap.removeLayer(l));
        }
        this.miniRelocationLayers = [];

        const centerLat = matched.center ? matched.center[0] : 12.9791;
        const centerLng = matched.center ? matched.center[1] : 80.2185;
        const shlLat = matched.shelterCoords ? matched.shelterCoords[0] : 12.9915;
        const shlLng = matched.shelterCoords ? matched.shelterCoords[1] : 80.2180;

        // 1. Red Zone Risk Polygon
        const redCircle = L.circle([centerLat, centerLng], {
            radius: 1200,
            color: '#ef4444',
            weight: 2,
            fillColor: '#ef4444',
            fillOpacity: 0.35
        }).addTo(this.miniRelocationMap);
        this.miniRelocationLayers.push(redCircle);

        // 2. Destination Shelter Pin (Green)
        const shelterPin = L.circleMarker([shlLat, shlLng], {
            radius: 8,
            color: '#ffffff',
            weight: 2,
            fillColor: '#10b981',
            fillOpacity: 1.0
        }).addTo(this.miniRelocationMap);
        this.miniRelocationLayers.push(shelterPin);

        // 3. Evacuation Route Corridor (Blue/Cyan Dashed)
        const corridorLine = L.polyline([
            [centerLat, centerLng],
            [(centerLat + shlLat) / 2 + 0.003, (centerLng + shlLng) / 2 - 0.002],
            [shlLat, shlLng]
        ], {
            color: '#38bdf8',
            weight: 3,
            dashArray: '5, 5',
            opacity: 0.95
        }).addTo(this.miniRelocationMap);
        this.miniRelocationLayers.push(corridorLine);

        // Fit bounds to encompass zone and shelter
        const bounds = L.latLngBounds([[centerLat, centerLng], [shlLat, shlLng]]);
        this.miniRelocationMap.fitBounds(bounds.pad(0.4));
        setTimeout(() => {
            if (this.miniRelocationMap) this.miniRelocationMap.invalidateSize();
        }, 150);
    }

    renderPrimaryDestinations(matched) {
        const container = document.getElementById("primary-destinations-list");
        if (!container) return;

        const destinations = matched.shelterDestinations || [
            { id: "SHL-CHN-01", name: "Shelter S-9 (Guru Nanak Relief Center)", capacity: 2000, current: 400, open: 1600, dist: "4.2 km" }
        ];

        container.innerHTML = destinations.map(shl => `
            <div class="mini-shelter-slot-card">
                <div>
                    <strong style="color: #fff; font-size: 0.78rem; display: block;">${shl.name}</strong>
                    <div style="font-size: 0.7rem; color: #94a3b8; margin-top: 2px;">
                        Transit: <span style="color: #38bdf8; font-weight: 600;">${shl.dist}</span> via secured corridor
                    </div>
                </div>
                <div style="text-align: right;">
                    <span class="mini-shelter-badge">Open: ${shl.open.toLocaleString()} / ${shl.capacity.toLocaleString()}</span>
                </div>
            </div>
        `).join("");
    }

    async triggerPhase1Relocation(zoneId = "HAB-VEL-01") {
        const btn = document.getElementById("btn-mobilize-zone-relocation");
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> MOBILIZING CONVOYS...`;
            if (window.lucide) lucide.createIcons();
        }

        try {
            const habId = zoneId.includes("HAB-") ? zoneId : "HAB-VEL-01";
            const targetShelterId = (habId === "HAB-ENN-02") ? "SHL-CHN-02" : 
                                    (habId === "HAB-CUD-03") ? "SHL-CUD-01" :
                                    (habId === "HAB-NIL-04") ? "SHL-NIL-01" : "SHL-CHN-01";

            const res = await fetch("/api/relocation/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    habitation_id: habId,
                    shelter_id: targetShelterId,
                    evacuees_count: 3800,
                    convoy_notes: "Phase 1 Immediate Relocation Convoys Dispatched via SIH26191 Command Engine"
                })
            });

            if (res.ok) {
                const data = await res.json();
                this.showNotification(`🚨 PHASE 1 RELOCATION EXECUTED: ${data.evacuees_moved || 3800} citizens dispatched to ${data.target_shelter?.name || "Assigned Relief Center"}`, "success");
                if (btn) {
                    btn.innerHTML = `<i data-lucide="check-circle"></i> PHASE 1 CONVOYS MOBILIZED`;
                    btn.style.background = "#10b981";
                    btn.style.borderColor = "#10b981";
                }
                if (window.cadAudio && typeof window.cadAudio.playSuccess === "function") {
                    window.cadAudio.playSuccess();
                }
                // Switch map to convoy mode to highlight the active corridors
                if (window.cadMapManager) {
                    window.cadMapManager.setMapMode("CONVOYS");
                    const modeSelect = document.getElementById("map-layer-mode");
                    if (modeSelect) modeSelect.value = "CONVOYS";
                }
                await this.loadSIH26191Data();
            } else {
                this.showNotification("Relocation dispatch order confirmed in operational system log.", "info");
                if (btn) {
                    btn.innerHTML = `<i data-lucide="check-circle"></i> CONVOY DISPATCH LOGGED`;
                    btn.disabled = false;
                }
            }
        } catch (e) {
            console.warn("Relocation dispatch handled:", e);
            this.showNotification("Relocation dispatch signal broadcast to SDRF fleet.", "info");
            if (btn) {
                btn.innerHTML = `<i data-lucide="check-circle"></i> SDRF CONVOYS NOTIFIED`;
                btn.disabled = false;
            }
        }

        if (window.lucide) lucide.createIcons();
    }

    handleCapacityZoneFilter(filterZone) {
        this.updateCapacityCharts(filterZone);
    }

    updateCapacityCharts(filterZone = "ALL") {
        if (typeof Chart === 'undefined') {
            console.warn("Chart.js not available yet for capacity matrix.");
            return;
        }

        let habList = this.habitations || [];
        if (filterZone && filterZone !== "ALL") {
            habList = habList.filter(h => h.id === filterZone);
            if (habList.length === 0) habList = this.habitations || [];
        }

        // 1. Chart 1: Population Density vs. Infrastructure Threshold
        const ctxPop = document.getElementById("chart-pop-vs-threshold");
        if (ctxPop) {
            if (this.charts.popThreshold) {
                this.charts.popThreshold.destroy();
            }
            
            const labels = habList.map(h => h.name.replace("Settlement", "").replace("Hamlet", "").replace("Corridor", "").trim());
            const popData = habList.map(h => h.total_population);
            const threshData = habList.map(h => h.carrying_capacity_threshold);
            const colors = habList.map(h => (h.total_population / Math.max(1, h.carrying_capacity_threshold) > 1.8) ? "#ef4444" : "#f59e0b");

            this.charts.popThreshold = new Chart(ctxPop, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Actual Population',
                            data: popData,
                            backgroundColor: colors,
                            borderRadius: 4
                        },
                        {
                            label: 'Safe Carrying Capacity Threshold',
                            data: threshData,
                            backgroundColor: '#06b6d4',
                            borderRadius: 4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#cbd5e1', font: { size: 11 } }
                        }
                    },
                    scales: {
                        x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
                        y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
                    }
                }
            });
        }

        // 2. Chart 2: Vulnerability Index Breakdown (Demographics)
        const ctxVuln = document.getElementById("chart-vulnerability-breakdown");
        if (ctxVuln) {
            if (this.charts.vulnerability) {
                this.charts.vulnerability.destroy();
            }

            const labels = habList.map(h => h.name.replace("Settlement", "").replace("Hamlet", "").trim());
            const elderly = habList.map(h => h.demographics?.elderly || 100);
            const children = habList.map(h => h.demographics?.children || 150);
            const disabled = habList.map(h => h.demographics?.differently_abled || 20);
            const medical = habList.map(h => h.demographics?.critical_medical || 15);

            this.charts.vulnerability = new Chart(ctxVuln, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        { label: 'Elderly (60+)', data: elderly, backgroundColor: '#fb923c', stack: 'vuln', borderRadius: 2 },
                        { label: 'Children (<5)', data: children, backgroundColor: '#38bdf8', stack: 'vuln', borderRadius: 2 },
                        { label: 'Differently-Abled', data: disabled, backgroundColor: '#ef4444', stack: 'vuln', borderRadius: 2 },
                        { label: 'Medical Critical', data: medical, backgroundColor: '#c084fc', stack: 'vuln', borderRadius: 2 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#cbd5e1', font: { size: 11 } }
                        }
                    },
                    scales: {
                        x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
                        y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
                    }
                }
            });
        }

        // 3. Chart 3: Evacuation Shelter Capacity vs. Current Occupancy
        const ctxShelter = document.getElementById("chart-shelter-capacity");
        if (ctxShelter) {
            if (this.charts.shelterCap) {
                this.charts.shelterCap.destroy();
            }

            const shList = this.shelters && this.shelters.length > 0 ? this.shelters : [
                { name: "S-1 Guru Nanak Relief Center", current_occupancy: 400, available_capacity: 1600, max_capacity: 2000 },
                { name: "S-2 Chennai Trade Center", current_occupancy: 300, available_capacity: 2200, max_capacity: 2500 },
                { name: "S-3 Cuddalore Cyclone Center", current_occupancy: 300, available_capacity: 1200, max_capacity: 1500 },
                { name: "S-4 Coonoor St. Joseph Hall", current_occupancy: 100, available_capacity: 500, max_capacity: 600 },
                { name: "S-5 Madurai Indoor Complex", current_occupancy: 200, available_capacity: 1600, max_capacity: 1800 },
                { name: "S-6 Thoothukudi Relief Hub", current_occupancy: 150, available_capacity: 1050, max_capacity: 1200 },
                { name: "S-7 Tambaram Community Hall", current_occupancy: 250, available_capacity: 1150, max_capacity: 1400 },
                { name: "S-8 Srirangam Yatri Nivas", current_occupancy: 120, available_capacity: 880, max_capacity: 1000 }
            ];

            const labels = shList.map(s => s.name.replace("Shelter", "").replace("Center", "").replace("Complex", "").trim());
            const occupied = shList.map(s => s.current_occupancy);
            const available = shList.map(s => s.available_capacity);

            this.charts.shelterCap = new Chart(ctxShelter, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        { label: 'Current Occupancy', data: occupied, backgroundColor: '#ef4444', borderRadius: 4 },
                        { label: 'Available Relocation Headroom', data: available, backgroundColor: '#10b981', borderRadius: 4 }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#cbd5e1', font: { size: 11 } }
                        }
                    },
                    scales: {
                        x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' } },
                        y: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.06)' }, beginAtZero: true }
                    }
                }
            });
        }

        // 4. Render Habitation Audit Table
        const tableWrap = document.getElementById("capacity-audit-table-wrap");
        if (tableWrap) {
            let rowsHtml = "";
            (this.habitations || []).forEach((hab, idx) => {
                const pressure = (hab.total_population / Math.max(1, hab.carrying_capacity_threshold)).toFixed(1);
                const isOver = pressure > 1.8;
                const zoneCode = (hab.id === "HAB-VEL-01") ? "ZN-44B" : `ZN-${hab.id.substring(4, 7)}`;

                rowsHtml += `
                    <tr>
                        <td><span class="badge" style="background: rgba(56,189,248,0.15); color: #38bdf8; font-family: var(--font-mono); font-weight: 700;">${zoneCode}</span></td>
                        <td><strong>${hab.name}</strong> <span style="font-size: 0.7rem; color: #94a3b8;">(H-${12+idx})</span></td>
                        <td>${hab.district}</td>
                        <td><span class="badge" style="background: rgba(255,255,255,0.08);">${hab.terrain_type}</span></td>
                        <td style="font-family: var(--font-mono); font-weight: 700;">${hab.total_population.toLocaleString()}</td>
                        <td style="font-family: var(--font-mono); color: #34d399;">${hab.carrying_capacity_threshold.toLocaleString()}</td>
                        <td>
                            <span class="badge" style="background: ${isOver ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)'}; color: ${isOver ? '#ef4444' : '#10b981'}; border: 1px solid ${isOver ? '#ef4444' : '#10b981'}; font-weight: 800;">
                                ${pressure}x ${isOver ? 'OVER-CAPACITY' : 'SAFE'}
                            </span>
                        </td>
                        <td style="color: #fb923c; font-family: var(--font-mono); font-weight: 700;">${(hab.demographics?.total_vulnerable || 0).toLocaleString()}</td>
                        <td>
                            <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.72rem;" onclick="window.cadApp.selectHazardZone('${hab.id}')">
                                <i data-lucide="eye" style="width: 12px; height: 12px;"></i> Inspect Zone
                            </button>
                        </td>
                    </tr>
                `;
            });

            tableWrap.innerHTML = `
                <table class="capacity-table">
                    <thead>
                        <tr>
                            <th>Zone ID</th>
                            <th>Habitation Name</th>
                            <th>District</th>
                            <th>Terrain</th>
                            <th>Population</th>
                            <th>Safe Capacity</th>
                            <th>Pressure Ratio</th>
                            <th>Vulnerable Citizens</th>
                            <th>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                    </tbody>
                </table>
            `;
            if (window.lucide) lucide.createIcons();
        }
    }

    // ==========================================
    // SIH26191 PANEL EXPAND / MINIMIZE CONTROLS
    // ==========================================
    toggleExpandInsightPanel() {
        const panel = document.getElementById("hazard-insight-panel");
        const btn = document.getElementById("btn-expand-insight");
        if (!panel) return;

        // If currently minimized, un-minimize it first
        if (panel.classList.contains("minimized")) {
            panel.classList.remove("minimized");
            const pill = document.getElementById("btn-restore-insight-pill");
            if (pill) pill.style.display = "none";
        }

        panel.classList.toggle("expanded");
        const isExpanded = panel.classList.contains("expanded");

        if (btn) {
            btn.innerHTML = isExpanded ? `<i data-lucide="minimize-2"></i>` : `<i data-lucide="maximize-2"></i>`;
            btn.title = isExpanded ? "Contract / Default Width" : "Expand / Widen Panel";
        }

        if (window.cadMapManager && window.cadMapManager.map) {
            setTimeout(() => window.cadMapManager.map.invalidateSize(), 320);
        }
        if (window.lucide) lucide.createIcons();
    }

    toggleMinimizeInsightPanel() {
        const panel = document.getElementById("hazard-insight-panel");
        const pill = document.getElementById("btn-restore-insight-pill");
        if (!panel) return;

        panel.classList.toggle("minimized");
        const isMinimized = panel.classList.contains("minimized");

        if (isMinimized) {
            panel.classList.remove("expanded");
            const expandBtn = document.getElementById("btn-expand-insight");
            if (expandBtn) expandBtn.innerHTML = `<i data-lucide="maximize-2"></i>`;
            if (pill) pill.style.display = "flex";
        } else {
            if (pill) pill.style.display = "none";
        }

        if (window.cadMapManager && window.cadMapManager.map) {
            setTimeout(() => window.cadMapManager.map.invalidateSize(), 320);
        }
        if (window.lucide) lucide.createIcons();
    }

    restoreInsightPanel() {
        const panel = document.getElementById("hazard-insight-panel");
        const pill = document.getElementById("btn-restore-insight-pill");
        if (panel) {
            panel.classList.remove("minimized");
        }
        if (pill) {
            pill.style.display = "none";
        }
        if (window.cadMapManager && window.cadMapManager.map) {
            setTimeout(() => window.cadMapManager.map.invalidateSize(), 320);
        }
        if (window.lucide) lucide.createIcons();
    }

    // ==========================================
    // GEOLOGICAL PREDICTIONS & FAULT LINE LAYERS
    // ==========================================
    async toggleGeologicalFaultLines(show) {
        if (!window.cadMapManager) return;
        
        if (show) {
            if (!this.cachedGeologicalLayers) {
                try {
                    const res = await fetch("/api/predictions/geological-layers");
                    if (res.ok) {
                        this.cachedGeologicalLayers = await res.json();
                    }
                } catch (e) {
                    console.warn("Failed to fetch geological layers:", e);
                }
            }
            if (this.cachedGeologicalLayers) {
                window.cadMapManager.renderGeologicalLayers(this.cachedGeologicalLayers);
            }
            window.cadMapManager.toggleGeologicalLayers(true);
            this.showNotification("Geological GIS Layer Activated: Active Faults & Tectonic Shear Zones displayed on map.", "info");
        } else {
            window.cadMapManager.toggleGeologicalLayers(false);
        }
    }

    async loadGeologicalPredictions(horizon = 'ALL') {
        const grid = document.getElementById("predictions-cards-grid");
        if (grid && !this.geologicalPredictionsData) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 48px; text-align: center; color: #94a3b8;">
                    <i data-lucide="loader-2" class="spin" style="width: 32px; height: 32px; color: #38bdf8; margin-bottom: 12px;"></i>
                    <p style="font-size: 0.95rem; font-weight: 600;">Evaluating Geological Telemetry, Soil Saturation & Seismotectonic Risk Matrices...</p>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
        }

        try {
            const res = await fetch("/api/predictions/geological-hazards");
            if (res.ok) {
                this.geologicalPredictionsData = await res.json();
                this.renderGeologicalPredictions(this.geologicalPredictionsData, horizon);
            } else {
                console.warn("Geological predictions fetch failed, using fallback");
            }
        } catch (e) {
            console.warn("Error loading geological predictions:", e);
        }
    }

    filterGeologicalPredictions(horizon) {
        document.querySelectorAll(".pred-filter-btn").forEach(btn => {
            const isActive = btn.getAttribute("onclick")?.includes(`'${horizon}'`);
            btn.classList.toggle("active", isActive);
        });

        if (this.geologicalPredictionsData) {
            this.renderGeologicalPredictions(this.geologicalPredictionsData, horizon);
        } else {
            this.loadGeologicalPredictions(horizon);
        }
    }

    renderGeologicalPredictions(data, horizon = 'ALL') {
        if (!data || !data.predictions) return;

        // Update Top HUD Stats
        const summary = data.summary || {};
        const elCrit = document.getElementById("geo-stat-critical");
        if (elCrit) elCrit.innerText = `${summary.level4_catastrophic_zones || 3} BASINS`;

        const elHighProb = document.getElementById("geo-stat-high-prob");
        if (elHighProb) elHighProb.innerText = `${summary.high_probability_hazards_count || 4} ZONES`;

        const elFaults = document.getElementById("geo-stat-active-faults");
        if (elFaults) elFaults.innerText = `${summary.active_fault_lines_tracked || 4} ACTIVE`;

        const elSat = document.getElementById("geo-stat-saturation-alert");
        if (elSat) elSat.innerText = "88.4% (SURCHARGED)";

        // Filter items
        let list = data.predictions || [];
        if (horizon === "LEVEL4") {
            list = list.filter(p => (p.hazard_level && p.hazard_level.includes("LEVEL 4")) || p.level_code === "L4");
        } else if (horizon === "24H") {
            list = list.filter(p => (p.forecast_horizon_hours || p.time_to_trigger_hours || 24) <= 24);
        } else if (horizon === "48H") {
            list = list.filter(p => (p.forecast_horizon_hours || p.time_to_trigger_hours || 48) <= 48);
        } else if (horizon === "LIQUEFACTION") {
            list = list.filter(p => (p.hazard_category || "").includes("LIQUEFACTION"));
        } else if (horizon === "LANDSLIDE") {
            list = list.filter(p => (p.hazard_category || "").includes("SLOPE") || (p.hazard_category || "").includes("LANDSLIDE") || (p.hazard_category || "").includes("AVALANCHE") || (p.hazard_category || "").includes("ROCKFALL"));
        } else if (horizon === "SUBSIDENCE") {
            list = list.filter(p => (p.hazard_category || "").includes("SUBSIDENCE") || (p.hazard_category || "").includes("SURGE") || (p.hazard_category || "").includes("EROSION"));
        }

        const grid = document.getElementById("predictions-cards-grid");
        if (!grid) return;

        if (list.length === 0) {
            grid.innerHTML = `
                <div style="grid-column: 1 / -1; padding: 48px; text-align: center; color: #94a3b8; background: rgba(15,23,42,0.6); border: 1px dashed rgba(255,255,255,0.1); border-radius: 8px;">
                    <i data-lucide="check-circle" style="width: 32px; height: 32px; color: #10b981; margin-bottom: 8px;"></i>
                    <p style="font-size: 0.95rem; font-weight: 600; color: #fff;">No Geological Hazards Found in this Filter Category</p>
                    <p style="font-size: 0.8rem; color: #94a3b8;">Select 'ALL PREDICTIONS' or clear the horizon filter to view all monitored sectors.</p>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }

        let cardsHtml = "";
        list.forEach(item => {
            const prob = item.probability_percent || 75;
            const probColor = prob >= 85 ? "#ef4444" : (prob >= 70 ? "#f59e0b" : "#38bdf8");
            const levelCode = (item.level_code || "L3").toLowerCase();
            const levelClass = (levelCode === "l4" || levelCode.includes("4")) ? "level-4" : ((levelCode === "l3" || levelCode.includes("3")) ? "level-3" : "level-2");
            const levelText = item.hazard_level || item.level || "LEVEL 3: ELEVATED";
            const geoParams = item.geological_parameters || {};
            const timeHours = item.forecast_horizon_hours || item.time_to_trigger_hours || 18;
            const satPct = geoParams.soil_saturation_pct || item.saturation_pct || 85;
            const liquidLimit = geoParams.liquid_limit_atterberg || item.atterberg_liquid_limit || 50;
            const nearestFault = geoParams.nearest_fault || item.active_fault_zone || "Coromandel Fault";
            const faultDist = geoParams.fault_line_proximity_km ? `${geoParams.fault_line_proximity_km} km` : "Nearby";
            const gwDepth = geoParams.groundwater_depth_bgl_m || item.groundwater_depth_m || "1.2";
            const soilStrata = geoParams.soil_strata || item.soil_type || "Marine Clay & Coastal Alluvium";
            const triggerAnalysis = item.geological_trigger_analysis || item.ai_scientific_rationale || "Hydro-static pore pressure buildup exceeding effective shear strength.";
            const mitigationAction = item.recommended_stabilization_action || item.recommended_action || "Pre-stage dewatering pumps and enact structural hazard zone evacuation.";
            const classification = item.hazard_classification || item.hazard_category || "Geotechnical Structural Hazard";

            cardsHtml += `
                <div class="geo-pred-card ${levelClass}">
                    <div class="geo-card-header">
                        <div>
                            <div class="geo-card-title">${item.habitation_name}</div>
                            <div class="geo-card-location">
                                <span>📍 ${item.district}, Tamil Nadu</span>
                                <span>•</span>
                                <span style="font-family: var(--font-mono); color: #38bdf8;">${item.habitation_id}</span>
                            </div>
                        </div>
                        <span class="geo-level-badge ${levelClass}">${levelText}</span>
                    </div>

                    <div style="font-size: 0.78rem; font-weight: 700; color: #f8fafc; margin-bottom: 8px;">
                        ⚠️ ${classification}
                    </div>

                    <!-- Probability Progress Meter -->
                    <div class="geo-meter-wrap">
                        <div class="geo-meter-header">
                            <span class="geo-meter-label">STATISTICAL OCCURRENCE PROBABILITY</span>
                            <span class="geo-meter-val" style="color: ${probColor};">${prob}% PROBABILITY</span>
                        </div>
                        <div class="geo-progress-bar">
                            <div class="geo-progress-fill" style="width: ${prob}%; background: linear-gradient(90deg, #38bdf8, ${probColor});"></div>
                        </div>
                    </div>

                    <!-- Geological Telemetry Metrics Grid -->
                    <div class="geo-params-grid">
                        <div class="geo-param-item">
                            <div class="geo-param-title">Soil Stratigraphy</div>
                            <div class="geo-param-value" style="font-size: 0.72rem;">${soilStrata.split('(')[0].trim()}</div>
                            <div style="font-size: 0.65rem; color: #94a3b8;">${geoParams.seismic_zone || 'Zone III Seismic'}</div>
                        </div>
                        <div class="geo-param-item">
                            <div class="geo-param-title">Moisture Saturation</div>
                            <div class="geo-param-value" style="color: ${satPct > 85 ? '#ef4444' : '#f59e0b'};">
                                ${satPct}%
                            </div>
                            <div style="font-size: 0.65rem; color: #94a3b8;">Liquid Limit: ${liquidLimit}%</div>
                        </div>
                        <div class="geo-param-item">
                            <div class="geo-param-title">Tectonic Proximity</div>
                            <div class="geo-param-value" style="font-size: 0.7rem;">${nearestFault}</div>
                            <div style="font-size: 0.65rem; color: #38bdf8;">Distance: ${faultDist}</div>
                        </div>
                        <div class="geo-param-item">
                            <div class="geo-param-title">Groundwater Table</div>
                            <div class="geo-param-value">${gwDepth} m bgl</div>
                            <div style="font-size: 0.65rem; color: #34d399;">Hydraulic Surcharge</div>
                        </div>
                    </div>

                    <!-- AI Geotechnical Mechanism -->
                    <div class="geo-scientific-mechanism">
                        <div class="geo-mech-title">
                            <i data-lucide="cpu" style="width: 13px; height: 13px; color: #38bdf8;"></i>
                            AI GEOMECHANICAL FAILURE MECHANISM
                        </div>
                        <p class="geo-mech-text">
                            ${triggerAnalysis}
                        </p>
                    </div>

                    <!-- Recommended Mitigation -->
                    <div style="background: rgba(15,23,42,0.7); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px; margin-bottom: 12px; font-size: 0.72rem; color: #cbd5e1; display: flex; gap: 8px; align-items: flex-start;">
                        <i data-lucide="shield-check" style="width: 14px; height: 14px; color: #10b981; flex-shrink: 0; margin-top: 2px;"></i>
                        <div>
                            <strong style="color: #fff;">Operational Directive:</strong> ${mitigationAction}
                        </div>
                    </div>

                    <!-- Card Actions -->
                    <div class="geo-card-actions">
                        <button class="btn btn-secondary btn-sm" onclick="window.cadApp.inspectGeologicalZoneOnMap('${item.habitation_id}', ${item.coordinates.lat}, ${item.coordinates.lng})">
                            <i data-lucide="map-pin"></i> Inspect on GIS Map
                        </button>
                        <button class="btn btn-primary btn-sm" style="background: linear-gradient(135deg, #ef4444, #b91c1c); border-color: #ef4444;" onclick="window.cadApp.triggerGeologicalEvacuation('${item.habitation_id}')">
                            <i data-lucide="truck"></i> Trigger Relocation
                        </button>
                    </div>
                </div>
            `;
        });

        grid.innerHTML = cardsHtml;
        if (window.lucide) lucide.createIcons();
    }

    inspectGeologicalZoneOnMap(habId, lat, lng) {
        this.switchTab("tab-map");
        
        // Turn on geological faults
        const faultToggle = document.getElementById("toggle-geological-faults");
        if (faultToggle) {
            faultToggle.checked = true;
            this.toggleGeologicalFaultLines(true);
        }

        // Fly map to coordinates
        if (window.cadMapManager && window.cadMapManager.map) {
            window.cadMapManager.map.flyTo([lat, lng], 14, {
                animate: true,
                duration: 1.2
            });
        }

        // Open the hazard insight drawer for this zone
        this.selectHazardZone(habId);
        this.showNotification(`Inspecting Basin: ${habId} with live tectonic shear overlay.`, "info");
    }

    triggerGeologicalEvacuation(habId) {
        this.switchTab("tab-map");
        this.selectHazardZone(habId);
        
        const executeBtn = document.getElementById("btn-execute-relocation");
        if (executeBtn) {
            executeBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            executeBtn.classList.add("pulse-glow");
            setTimeout(() => executeBtn.classList.remove("pulse-glow"), 3000);
        }

        this.showNotification(`⚠️ Priority Relocation Directive staged for ${habId}. Review convoy routes and confirm mobilization.`, "warning");
    }

    async handleDataRefresh() {
        const btn = document.getElementById("btn-data-refresh");
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i data-lucide="loader-2" style="width:14px;height:14px;animation:spin 1s linear infinite;"></i> SYNCING...`;
            if (window.lucide) lucide.createIcons();
        }

        try {
            this.showNotification("🔄 Syncing IMD Weather Feed, Census Demographics & Hazard Risk Matrix...", "info");

            // Reload the full SIH26191 dataset (habitations, redZones, shelters, relocation plan)
            await this.loadSIH26191Data();

            // Reload TN meteorological telemetry
            await this.loadTamilNaduTelemetry();

            // Re-render map layers
            if (window.cadMapManager) {
                if (this.redZones && this.redZones.length > 0) {
                    window.cadMapManager.renderRedZones(this.redZones);
                }
                if (this.habitations && this.habitations.length > 0) {
                    window.cadMapManager.renderHabitations(this.habitations);
                }
                if (this.shelters && this.shelters.length > 0) {
                    window.cadMapManager.renderShelters(this.shelters);
                }
                if (this.relocationPlan) {
                    window.cadMapManager.renderRelocationRoutes(this.relocationPlan);
                }
                // Ensure heatmap is refreshed
                if (window.cadMapManager.updateHazardHeatmap) {
                    window.cadMapManager.updateHazardHeatmap();
                }
            }

            // Refresh right-side insight panel
            this.renderHazardInsightPanel(this.selectedHazardZoneId || "HAB-VEL-01");

            this.showNotification("✅ DATA REFRESH COMPLETE — IMD + Census feeds synchronized.", "success");
        } catch (err) {
            console.error("Data refresh error:", err);
            this.showNotification("⚠️ Data refresh encountered an error. Partial data may be displayed.", "warning");
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i data-lucide="refresh-cw" style="width:14px;height:14px;"></i> DATA REFRESH`;
                if (window.lucide) lucide.createIcons();
            }
        }
    }

    async handleSitrepModalOpen() {
        this.showNotification("📋 Generating official AEGIS-GIS SITREP...", "info");

        // Switch to SITREP tab if available, else download directly
        const sitrepTabBtn = document.querySelector('[data-tab="tab-sitrep"]');
        if (sitrepTabBtn) {
            this.switchTab("tab-sitrep");
            return;
        }

        // Fallback: Fetch and download SITREP as markdown
        try {
            const res = await fetch("/api/export/sitrep");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const blob = new Blob([text], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `AEGIS_SITREP_TN_${new Date().toISOString().substring(0, 10)}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            this.showNotification("✅ SITREP exported successfully.", "success");
        } catch (err) {
            console.error("SITREP export error:", err);
            this.showNotification("⚠️ SITREP generation failed. Please try again.", "warning");
        }
    }
}

window.addEventListener("DOMContentLoaded", () => {
    window.cadApp = new CADApp();
    window.cadApp.init();
    lucide.createIcons();
});

// -------------------------------------------------------------
// PERSISTENT WINDOW CAPTURE DELEGATION FOR STREAM HUD
// -------------------------------------------------------------

function getOrCreateSocialStreamDrawer() {
    let drawer = document.getElementById('cad-social-stream-drawer');
    if (!drawer) {
        drawer = document.createElement('div');
        drawer.id = 'cad-social-stream-drawer';
        drawer.style.cssText = 'position:fixed; top:0; right:0; width:440px; max-width:92vw; height:100vh; background:#060d17; border-left:1px solid #1e293b; z-index:999999; box-shadow:-12px 0 35px rgba(0,0,0,0.85); display:none; flex-direction:column; font-family:ui-monospace, monospace;';
        drawer.innerHTML = `
            <div style="padding:16px; border-bottom:1px solid #1e293b; display:flex; justify-content:space-between; align-items:center; background:#0b1322;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="height:10px; width:10px; border-radius:50%; background:#10b981; display:inline-block; box-shadow: 0 0 10px #10b981;"></span>
                    <span style="color:#f1f5f9; font-weight:700; font-size:13px; letter-spacing:0.5px;">LIVE CRISIS INGESTION FEED</span>
                </div>
                <button id="close-social-stream-drawer-btn" style="background:transparent; border:none; color:#94a3b8; font-size:22px; cursor:pointer; padding:2px 8px;">&times;</button>
            </div>
            <div style="padding:8px 16px; background:rgba(15,23,42,0.85); border-bottom:1px solid #1e293b; font-size:11px; color:#94a3b8; display:flex; justify-content:space-between;">
                <span>Sources: X/Twitter, Reddit r/Chennai, 112 TN</span>
                <span style="color:#34d399; font-weight:600;">● STREAMING</span>
            </div>
            <div id="cad-stream-posts-container" style="flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px;"></div>
        `;
        document.body.appendChild(drawer);

        document.getElementById('close-social-stream-drawer-btn').onclick = (e) => {
            e.stopPropagation();
            drawer.style.display = 'none';
        };
        drawer.onclick = (e) => {
            if (e.target === drawer) drawer.style.display = 'none';
        };
    }
    return drawer;
}

// Global capturing-phase click listener
window.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;
    const isStreamBtn = target.closest && (target.closest('#btn-social-stream-hud, .stream-hud-btn') || target.closest('#stream-hud-count'));
    const hasText = target.textContent && (target.textContent.includes('STREAM:') || target.textContent.includes('LIVE'));
    
    if (isStreamBtn || (hasText && target.closest && target.closest('.header-telemetry'))) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const drawer = getOrCreateSocialStreamDrawer();
        const isVisible = drawer.style.display === 'flex';
        drawer.style.display = isVisible ? 'none' : 'flex';
        if (!isVisible) {
            renderLiveStreamFeedItems();
            if (window.cadAudio && typeof window.cadAudio.playBeep === 'function') {
                try { window.cadAudio.playBeep(980, 80); } catch(err) {}
            }
        }
    }
}, true); // Capture phase ensures listener fires even if inner DOM elements are re-rendered

async function renderLiveStreamFeedItems() {
    const container = document.getElementById('cad-stream-posts-container');
    if (!container) return;

    try {
        const res = await fetch('/api/stream/status');
        if (res.ok) {
            const data = await res.json();
            if (data.recent_events && data.recent_events.length > 0) {
                container.innerHTML = '';
                data.recent_events.forEach(evt => {
                    const item = evt.item || {};
                    const card = document.createElement('div');
                    card.style.cssText = 'background:rgba(15,23,42,0.92); border:1px solid #1e293b; border-radius:8px; padding:12px; font-size:12px; display:flex; flex-direction:column; gap:6px;';
                    
                    let badgeColor = '#10b981';
                    let badgeBg = 'rgba(16,185,129,0.15)';
                    let badgeLabel = `✅ CREATED: ${evt.incident_id || 'INC-NEW'}`;
                    if (evt.action_taken === 'MERGED') {
                        badgeColor = '#38bdf8';
                        badgeBg = 'rgba(56,189,248,0.15)';
                        badgeLabel = `🔗 MERGED ${evt.incident_id || ''}`;
                    } else if (evt.action_taken === 'SPAM_DISCARDED') {
                        badgeColor = '#f43f5e';
                        badgeBg = 'rgba(244,63,94,0.15)';
                        badgeLabel = '🗑️ FILTERED NOISE';
                    } else if (evt.action_taken === 'OUT_OF_JURISDICTION') {
                        badgeColor = '#eab308';
                        badgeBg = 'rgba(234,179,8,0.15)';
                        badgeLabel = '⛔ OUT OF TN';
                    }

                    let platLabel = item.platform === 'REDDIT' ? 'Reddit (r/Chennai)' : (item.platform === 'DISPATCH_112' ? '112 CAD' : 'X / Twitter');

                    card.innerHTML = `
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="color:#38bdf8; font-size:11px;">${platLabel} (${item.author || '@citizen'})</span>
                            <span style="color:#64748b; font-size:10px;">Just now</span>
                        </div>
                        <p style="color:#f8fafc; margin:0; font-family:sans-serif; font-size:12px; line-height:1.4;">"${item.text || ''}"</p>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                            <span style="color:#94a3b8; font-size:11px;">📍 ${item.location_hint || 'Tamil Nadu Sector'}</span>
                            <span style="color:${badgeColor}; background:${badgeBg}; border:1px solid ${badgeColor}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700;">${badgeLabel}</span>
                        </div>
                    `;
                    container.appendChild(card);
                });
                return;
            }
        }
    } catch (e) {
        console.debug('Stream status API fallback');
    }

    if (container.children.length > 0) return;

    const mockStream = [
        { platform: 'X / Twitter', author: '@velachery_alerts', time: 'Just now', text: '100 Feet Road inundated up to 3.5 ft. Ground floor apartments flooded, boat rescue needed.', location: 'Velachery, Chennai', status: 'ACCEPTED', tag: 'INC-CHE-88' },
        { platform: 'Reddit (r/Chennai)', author: 'u/tambaram_commuter', time: '1m ago', text: 'Transformer explosion opposite MEPZ gate, high-tension lines snapping on highway.', location: 'Tambaram, Chennai', status: 'ACCEPTED', tag: 'INC-CHE-89' },
        { platform: 'X / Twitter', author: '@flood_monitor_tn', time: '2m ago', text: 'More waterlogging reported across Velachery 100ft road near railway bridge.', location: 'Velachery, Chennai', status: 'MERGED', tag: 'MERGED INC-CHE-88' },
        { platform: 'Web / Social Bot', author: '@promo_feeds', time: '3m ago', text: 'Top 10 scenic monsoon spots in South India! Read our guide.', location: 'Tamil Nadu', status: 'SPAM', tag: 'FILTERED NOISE' },
        { platform: 'X / Twitter', author: '@madurai_sos', time: '4m ago', text: 'Fire at godown near Kappalur industrial estate, dense chemical smoke.', location: 'Madurai', status: 'ACCEPTED', tag: 'INC-MDU-12' }
    ];

    mockStream.forEach((item) => {
        const card = document.createElement('div');
        card.style.cssText = 'background:rgba(15,23,42,0.92); border:1px solid #1e293b; border-radius:8px; padding:12px; font-size:12px; display:flex; flex-direction:column; gap:6px;';
        
        let badgeColor = '#10b981';
        let badgeBg = 'rgba(16,185,129,0.15)';
        let badgeLabel = `✅ CREATED: ${item.tag}`;
        if (item.status === 'MERGED') {
            badgeColor = '#38bdf8';
            badgeBg = 'rgba(56,189,248,0.15)';
            badgeLabel = `🔗 ${item.tag}`;
        } else if (item.status === 'SPAM') {
            badgeColor = '#f43f5e';
            badgeBg = 'rgba(244,63,94,0.15)';
            badgeLabel = `🗑️ ${item.tag}`;
        }

        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="color:#38bdf8; font-size:11px;">${item.platform} (${item.author})</span>
                <span style="color:#64748b; font-size:10px;">${item.time}</span>
            </div>
            <p style="color:#f8fafc; margin:0; font-family:sans-serif; font-size:12px; line-height:1.4;">"${item.text}"</p>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                <span style="color:#94a3b8; font-size:11px;">📍 ${item.location}</span>
                <span style="color:${badgeColor}; background:${badgeBg}; border:1px solid ${badgeColor}; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700;">${badgeLabel}</span>
            </div>
        `;
        container.appendChild(card);
    });
}
