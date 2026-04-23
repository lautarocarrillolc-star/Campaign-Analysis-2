* {
  box-sizing: border-box;
}

:root {
  --bg: #fafafa;
  --panel: #ffffff;
  --text: #18181b;
  --muted: #3f3f46;
  --border: #e4e4e7;
  --border-soft: #d4d4d8;
  --thead: #f4f4f5;
}

body[data-theme='dark'] {
  --bg: #0f1115;
  --panel: #171a21;
  --text: #f4f4f5;
  --muted: #a1a1aa;
  --border: #2b3340;
  --border-soft: #3b4250;
  --thead: #202634;
}

body {
  margin: 0;
  font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  transition: background 260ms ease, color 260ms ease;
}

.layout {
  display: grid;
  grid-template-columns: 310px 1fr;
  min-height: 100vh;
}

.filters {
  border-right: 1px solid var(--border);
  padding: 24px;
  background: var(--panel);
  display: flex;
  flex-direction: column;
  gap: 14px;
  transition: background 260ms ease, border-color 260ms ease;
}

.titleRow {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.filters h1 {
  margin: 0 0 6px;
  font-size: 24px;
}

.modeBtn {
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  padding: 7px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 220ms ease;
}

.modeBtn:hover {
  transform: translateY(-1px);
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
}

select,
input {
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  min-height: 38px;
  padding: 7px 10px;
  font-size: 14px;
  background: var(--panel);
  color: var(--text);
  transition: all 220ms ease;
}

.multiSelect {
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  overflow: hidden;
}

.multiSelect summary {
  list-style: none;
  cursor: pointer;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
}

.multiSelect summary::-webkit-details-marker {
  display: none;
}

.selectedValue {
  color: var(--muted);
  font-weight: 500;
  font-size: 12px;
}

.multiSelectList {
  border-top: 1px solid var(--border);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 190px;
  overflow: auto;
}

.searchInput {
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  min-height: 32px;
  padding: 6px 8px;
  font-size: 12px;
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--panel);
}

.optionRow {
  display: flex;
  flex-direction: row;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
}

.clearBtn {
  background: var(--thead);
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
  margin-bottom: 4px;
}

.toggleRow {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.heatmapWrap {
  padding: 18px 20px;
}

.legend {
  margin: 0 0 12px;
  color: var(--muted);
}

.sourceInfo {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.errorInfo {
  margin: 0;
  font-size: 12px;
  color: #ef4444;
}

.heatmapScroll {
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  transition: all 260ms ease;
}

.heatmap {
  border-collapse: collapse;
  width: max-content;
  min-width: 100%;
}

.heatmap th,
.heatmap td {
  border: 1px solid var(--border);
  padding: 8px;
  text-align: center;
  white-space: nowrap;
  font-size: 12px;
}

.heatmap thead th {
  background: var(--thead);
  position: sticky;
  top: 0;
  z-index: 1;
}

.predictedCell {
  border-style: dashed !important;
  border-width: 3px !important;
  border-color: #f59e0b !important;
  box-shadow: inset 0 0 0 2px rgba(245, 158, 11, 0.55);
  font-weight: 700;
}

.predictionExplain {
  margin-top: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--panel);
}

.predictionExplain h3 {
  margin: 0 0 8px;
}

.predictionExplain ol,
.predictionExplain ul {
  margin: 6px 0 0;
  padding-left: 18px;
}

.predictionExplain li {
  margin-bottom: 6px;
}

.ratioTitle {
  margin: 10px 0 4px;
  font-weight: 700;
}

.ratioChartCard {
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 12px;
  background: var(--panel);
}

.ratioChartCard h3 {
  margin: 0 0 6px;
}

.ratioHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.ratioToggleWrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.ratioBtn {
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  padding: 5px 9px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  transition: all 220ms ease;
}

.ratioBtn.active {
  background: var(--thead);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

.ratioChart {
  width: 100%;
  height: 300px;
  display: block;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel) 90%, #0a1628 10%);
}

.ratioChartWrap {
  position: relative;
}

.ratioHoverGuide {
  position: absolute;
  top: 20px;
  bottom: 30px;
  width: 1px;
  background: color-mix(in srgb, var(--text) 45%, transparent 55%);
  pointer-events: none;
}

.gridLine {
  stroke: var(--border);
  stroke-dasharray: 3 4;
}

.axisLine {
  stroke: color-mix(in srgb, var(--text) 40%, transparent 60%);
  stroke-width: 1.2;
}

.axisLabel {
  fill: var(--muted);
  font-size: 11px;
}

.ratioLine {
  fill: none;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.95;
  transition: opacity 260ms ease, d 260ms ease;
}

.ratioPoint {
  opacity: 0;
  transition: opacity 200ms ease;
}

.ratioChart:hover .ratioPoint {
  opacity: 0.75;
}

.ratioPoint:hover {
  opacity: 1;
}

.ratioHoverPanel {
  position: absolute;
  top: 26px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--panel) 95%, #0b1220 5%);
  font-size: 12px;
  min-width: 210px;
  max-width: 290px;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.22);
  pointer-events: none;
  z-index: 3;
}

.ratioHoverPanel ul {
  margin: 6px 0 0;
  padding-left: 16px;
}

.hoverLabel {
  font-weight: 700;
}

.heatmap tbody th {
  position: sticky;
  left: 0;
  background: var(--bg);
}

@media (max-width: 950px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .filters {
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}

