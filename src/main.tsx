import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

/** Страховка от «чистого листа»: ошибка рендера показывает диагноз, а не пустоту. */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0d12", color: "#e9edf5", fontFamily: "'Golos Text','Segoe UI',sans-serif", padding: 24 }}>
          <div style={{ maxWidth: 520, border: "1px solid #263043", borderRadius: 14, background: "#131924", padding: "28px 28px 24px" }}>
            <div style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: "#ff6a5e" }}>
              сбой запуска
            </div>
            <div style={{ marginTop: 10, fontSize: 19, fontWeight: 700 }}>Приложению не удалось отрисовать интерфейс</div>
            <div style={{ marginTop: 10, fontSize: 13, color: "#aab6cb", lineHeight: 1.55 }}>
              Ошибка произошла локально в вашем браузере (подробности — в консоли, F12). Попробуйте перезагрузить страницу или открыть её в Chrome / Edge.
            </div>
            <pre style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "#0a0d12", border: "1px solid #263043", color: "#ff958c", fontFamily: "'JetBrains Mono',monospace", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {String(this.state.error?.message ?? this.state.error)}
            </pre>
            <button onClick={() => window.location.reload()} style={{ marginTop: 16, border: "none", borderRadius: 10, background: "#ff4b3e", color: "#fff", fontWeight: 700, fontSize: 14, padding: "11px 22px", cursor: "pointer" }}>
              Перезагрузить
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
