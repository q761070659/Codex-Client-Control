package io.github.codex.mccontrol;

import java.util.logging.Logger;

import net.fabricmc.api.ClientModInitializer;

public final class CodexClientControlMod implements ClientModInitializer {
    private static final Logger LOGGER = Logger.getLogger(CodexClientControlMod.class.getName());

    @Override
    public void onInitializeClient() {
        ControlBootstrap.startAsync(LOGGER);
    }
}
