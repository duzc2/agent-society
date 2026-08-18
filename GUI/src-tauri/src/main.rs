// release 构建不显示控制台窗口;debug 保留控制台便于开发期观察
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_society_launcher_lib::run();
}
