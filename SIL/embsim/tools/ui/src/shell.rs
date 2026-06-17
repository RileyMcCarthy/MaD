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

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a view with distinctive id/icon/name/css/js so generated markup
    /// can be asserted unambiguously. `render` only reads the `View` argument,
    /// so these construct local values and never touch the global registry.
    fn view(id: &str, name: &str, icon: &str) -> View {
        View::new(
            id,
            name,
            icon,
            &format!("<p id=\"body-{id}\">hi</p>"),
            &format!(".cls-{id} {{ color: red; }}"),
            &format!("doStuff('{id}');"),
            None,
        )
    }

    /// The rendered page is a complete HTML document with the embsim title.
    #[test]
    fn render_is_a_full_html_document() {
        let html = render(&[view("trace", "Trace Viewer", "📊")]);
        assert!(html.contains("<!DOCTYPE html>"), "has doctype");
        assert!(html.contains("<title>embsim</title>"), "has embsim title");
        assert!(html.trim_end().ends_with("</html>"), "closes html");
    }

    /// Each view contributes one nav button carrying its id (data-view +
    /// switchView call), icon, and display name.
    #[test]
    fn render_emits_a_nav_button_per_view() {
        let views = [
            view("trace", "Trace Viewer", "📊"),
            view("viz", "Visualizer", "🤖"),
        ];
        let html = render(&views);
        for v in &views {
            assert!(
                html.contains(&format!(r#"data-view="{}""#, v.id)),
                "nav button references id via data-view: {}",
                v.id
            );
            assert!(
                html.contains(&format!("switchView('{}')", v.id)),
                "nav button wires switchView for: {}",
                v.id
            );
            assert!(
                html.contains(&format!("{} {}", v.icon, v.name)),
                "nav button shows icon and name for: {}",
                v.id
            );
        }
        // Exactly one nav button per view. `<button class="shell-tab` is the
        // button markup — distinct from the `.shell-tab` CSS rules and JS
        // selectors, which appear regardless of view count.
        assert_eq!(
            html.matches(r#"<button class="shell-tab"#).count(),
            views.len(),
            "one nav button per view",
        );
    }

    /// The first view's tab is marked active (`shell-tab active`) and its panel
    /// is shown with `display:flex`; later panels are hidden with `display:none`.
    #[test]
    fn render_activates_only_the_first_view() {
        let html = render(&[view("first", "First", "1️⃣"), view("second", "Second", "2️⃣")]);

        // First tab is active, with its panel flexed.
        assert!(
            html.contains(r#"class="shell-tab active" data-view="first""#),
            "first tab carries the active class"
        );
        assert!(
            html.contains(r#"id="view-first" style="display:flex"#),
            "first panel uses display:flex"
        );

        // Second tab is not active, and its panel is hidden.
        assert!(
            html.contains(r#"class="shell-tab" data-view="second""#),
            "second tab is not active"
        );
        assert!(
            html.contains(r#"id="view-second" style="display:none"#),
            "second panel uses display:none"
        );
    }

    /// Each non-empty view CSS is emitted under its own `/* === View: <id> === */`
    /// marker.
    #[test]
    fn render_scopes_css_under_per_view_marker() {
        let views = [view("trace", "Trace", "📊"), view("viz", "Viz", "🤖")];
        let html = render(&views);
        for v in &views {
            assert!(
                html.contains(&format!("/* === View: {} === */", v.id)),
                "css marker present for: {}",
                v.id
            );
            assert!(
                html.contains(&format!(".cls-{} {{ color: red; }}", v.id)),
                "view css body present for: {}",
                v.id
            );
        }
    }

    /// Each non-empty view JS is wrapped in an IIFE that sets `VIEW_ID` and
    /// `VIEW_WS_PATH='/ws/<id>'` and embeds the view's script body.
    #[test]
    fn render_wraps_js_in_iife_with_view_constants() {
        let html = render(&[view("trace", "Trace", "📊")]);
        assert!(html.contains("(function() {"), "JS wrapped in an IIFE open");
        assert!(html.contains("})();"), "IIFE is invoked");
        assert!(
            html.contains("const VIEW_ID = 'trace';"),
            "VIEW_ID constant set to the view id"
        );
        assert!(
            html.contains("const VIEW_WS_PATH = '/ws/trace';"),
            "VIEW_WS_PATH points at the per-view ws path"
        );
        assert!(html.contains("doStuff('trace');"), "view JS body embedded");
        assert!(
            html.contains("// === View: trace ==="),
            "JS marker comment present"
        );
    }

    /// A view with empty CSS/JS contributes no style block marker and no script
    /// wrapper for that view (the empty-string guards skip it).
    #[test]
    fn render_skips_empty_css_and_js() {
        let v = View::new("bare", "Bare", "⬜", "<p>body</p>", "", "", None);
        let html = render(&[v]);
        // Still a valid document with the nav button and panel.
        assert!(html.contains("<!DOCTYPE html>"));
        assert!(html.contains(r#"data-view="bare""#));
        // But no per-view CSS marker or JS IIFE for the empty bodies.
        assert!(
            !html.contains("/* === View: bare === */"),
            "no css marker for empty css"
        );
        assert!(
            !html.contains("const VIEW_ID = 'bare';"),
            "no JS wrapper for empty js"
        );
    }

    /// An empty view slice still renders a valid shell — full document, the
    /// embsim title bar — with no panels or tabs.
    #[test]
    fn render_empty_slice_is_a_valid_empty_shell() {
        let html = render(&[]);
        assert!(html.contains("<!DOCTYPE html>"), "valid document");
        assert!(html.contains("<title>embsim</title>"));
        assert!(html.contains(r#"⚡ embsim"#), "shell chrome present");
        // No per-view markup. (Don't test `data-view=` — the static JS selector
        // `.shell-tab[data-view="..."]` contains that substring regardless.)
        assert!(!html.contains(r#"<button class="shell-tab"#), "no nav buttons");
        assert!(!html.contains("class=\"shell-view\""), "no view panels");
    }
}
