// 在 ComfyUI 主介面加一個「開啟 Yomu」的指令與選單項目
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "Yomu.Launcher",
  commands: [
    {
      id: "Yomu.Open",
      label: "開啟 Yomu",
      icon: "pi pi-bolt",
      function: () => window.open("/yomu", "_blank"),
    },
  ],
  menuCommands: [{ path: ["Extensions"], commands: ["Yomu.Open"] }],
});
