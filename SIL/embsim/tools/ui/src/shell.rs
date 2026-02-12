//! Shell HTML generator — builds the outer page layout with navigation tabs.
//!
//! Each registered view's CSS/HTML/JS is injected into a tabbed container.
//! Only one view is visible at a time; tab switching is pure client-side JS.

use crate::View;

/// Build the complete shell HTML page from all registered views.
pub fn render(views: &[View]) -> String {
    let mut nav_tabs = String::new();
    let mut view_panels = String::new();
    let mut view_styles = String::new();
    let mut view_scripts = String::new();

    for (i, view) in views.iter().enumerate() {
        let active = if i == 0 { " active" } else { "" };

        // Navigation tab
        nav_tabs.push_str(&format!(
            r#"<button class="shell-tab{active}" data-view="{id}" onclick="switchView('{id}')">{icon} {name}</button>"#,
            active = active,
            id = view.id,
            icon = view.icon,
            name = view.name,
        ));
        nav_tabs.push('\n');

        // View panel (content area)
        let display = if i == 0 { "flex" } else { "none" };
        view_panels.push_str(&format!(
            r#"<div class="shell-view" id="view-{id}" style="display:{display};flex-direction:column;flex:1;overflow:hidden;">{html}</div>"#,
            id = view.id,
            display = display,
            html = view.html,
        ));
        view_panels.push('\n');

        // Scoped CSS
        if !view.css.is_empty() {
            view_styles.push_str(&format!(
                "/* === View: {} === */\n{}\n",
                view.id, view.css
            ));
        }

        // Scoped JS
        if !view.js.is_empty() {
            view_scripts.push_str(&format!(
                "// === View: {} ===\n(function() {{\nconst VIEW_ID = '{}';\nconst VIEW_WS_PATH = '/ws/{}';\n{}\n}})();\n",
                view.id, view.id, view.id, view.js
            ));
        }
    }

    format!(
        r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>embsim</title>
<style>
  :root {{
    --bg: #1e1e2e;
    --surface: #292a3e;
    --surface2: #33344d;
    --border: #444566;
    --text: #cdd6f4;
    --text-dim: #888aaa;
    --accent: #89b4fa;
    --green: #a6e3a1;
    --red: #f38ba8;
    --yellow: #f9e2af;
    --purple: #cba6f7;
    --pink: #f5c2e7;
    --teal: #94e2d5;
    --orange: #fab387;
  }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    background: var(--bg);
    color: var(--text);
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }}

  /* Shell navigation bar */
  .shell-nav {{
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 0 12px;
    display: flex;
    align-items: stretch;
    gap: 0;
    flex-shrink: 0;
    height: 36px;
  }}
  .shell-nav-title {{
    display: flex;
    align-items: center;
    padding: 0 12px 0 4px;
    font-size: 14px;
    font-weight: 600;
    color: var(--accent);
    margin-right: 8px;
    border-right: 1px solid var(--border);
  }}
  .shell-tab {{
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-dim);
    font-family: inherit;
    font-size: 12px;
    padding: 0 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: color 0.15s, border-color 0.15s;
  }}
  .shell-tab:hover {{ color: var(--text); }}
  .shell-tab.active {{
    color: var(--accent);
    border-bottom-color: var(--accent);
  }}

  /* Shell content area */
  .shell-content {{
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }}

  /* Scrollbar (shared) */
  ::-webkit-scrollbar {{ width: 6px; }}
  ::-webkit-scrollbar-track {{ background: var(--bg); }}
  ::-webkit-scrollbar-thumb {{ background: var(--border); border-radius: 3px; }}
  ::-webkit-scrollbar-thumb:hover {{ background: var(--text-dim); }}

  /* View-specific styles */
  {view_styles}
</style>
</head>
<body>

<nav class="shell-nav">
  <div class="shell-nav-title">⚡ embsim</div>
  {nav_tabs}
</nav>

<div class="shell-content">
  {view_panels}
</div>

<script>
// Shell tab switching
function switchView(viewId) {{
  document.querySelectorAll('.shell-view').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.shell-tab').forEach(el => el.classList.remove('active'));
  const panel = document.getElementById('view-' + viewId);
  if (panel) panel.style.display = 'flex';
  const tab = document.querySelector('.shell-tab[data-view="' + viewId + '"]');
  if (tab) tab.classList.add('active');
  // Dispatch a custom event so views can react to becoming visible
  window.dispatchEvent(new CustomEvent('embsim-view-activate', {{ detail: {{ viewId }} }}));
}}

// View-specific scripts
{view_scripts}
</script>
</body>
</html>"##,
        view_styles = view_styles,
        nav_tabs = nav_tabs,
        view_panels = view_panels,
        view_scripts = view_scripts,
    )
}
