package io.github.codex.mccontrol;

import java.util.logging.Logger;

import net.neoforged.fml.common.Mod;

@Mod("codex_client_control")
public final class CodexClientControlNeoForgeMod {
    private static final Logger LOGGER = Logger.getLogger(CodexClientControlNeoForgeMod.class.getName());

    public CodexClientControlNeoForgeMod() {
        ControlBootstrap.startAsync(LOGGER);
    }
}
