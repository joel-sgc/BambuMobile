fn main() {
    // Declare the printNotification mobile plugin so Tauri's ACL system
    // generates allow-/deny- permissions for each of its three commands.
    // Without this, invoke('plugin:printNotification|...') is blocked by the
    // ACL before it ever reaches PluginManager.runCommand() on Android.
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "printNotification",
            tauri_build::InlinedPlugin::new()
                .commands(&["start_notification", "update_notification", "stop_notification"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
