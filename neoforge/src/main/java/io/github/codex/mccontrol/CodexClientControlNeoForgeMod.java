package io.github.codex.mccontrol;

import java.util.logging.Logger;

import net.neoforged.fml.ModLoadingContext;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLClientSetupEvent;

@Mod("codex_client_control")
public final class CodexClientControlNeoForgeMod {
    private static final Logger LOGGER = Logger.getLogger(CodexClientControlNeoForgeMod.class.getName());

    public CodexClientControlNeoForgeMod() {
        ModLoadingContext.get().getActiveContainer().getEventBus().addListener(this::onClientSetup);
    }

    private void onClientSetup(FMLClientSetupEvent event) {
        event.enqueueWork(() -> ControlBootstrap.start(LOGGER));
    }
}
