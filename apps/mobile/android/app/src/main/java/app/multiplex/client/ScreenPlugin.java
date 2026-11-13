package app.multiplex.client;

import android.content.pm.ActivityInfo;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Orientation de l'écran : le lecteur passe en paysage (dans un sens ou dans l'autre, selon
 * comment on tient le téléphone) et rend la main à la rotation normale quand on le quitte.
 */
@CapacitorPlugin(name = "MultiplexScreen")
public class ScreenPlugin extends Plugin {
    private void set(int orientation, PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().setRequestedOrientation(orientation);
            call.resolve();
        });
    }

    @PluginMethod
    public void landscape(PluginCall call) {
        set(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, call);
    }

    @PluginMethod
    public void release(PluginCall call) {
        set(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, call);
    }
}
