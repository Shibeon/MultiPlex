package app.multiplex.client;

import android.net.Uri;
import androidx.mediarouter.app.MediaRouteChooserDialog;
import androidx.mediarouter.media.MediaRouteSelector;
import androidx.mediarouter.media.MediaRouter;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.cast.CastMediaControlIntent;
import com.google.android.gms.cast.MediaInfo;
import com.google.android.gms.cast.MediaLoadRequestData;
import com.google.android.gms.cast.MediaMetadata;
import com.google.android.gms.cast.MediaSeekOptions;
import com.google.android.gms.cast.MediaStatus;
import com.google.android.gms.cast.framework.CastContext;
import com.google.android.gms.cast.framework.CastSession;
import com.google.android.gms.cast.framework.SessionManagerListener;
import com.google.android.gms.cast.framework.media.RemoteMediaClient;
import com.google.android.gms.common.images.WebImage;

/**
 * Envoi vers un téléviseur (Chromecast, Google TV, téléviseurs « Chromecast intégré ») depuis
 * l'application Android. Même contrat que l'application de bureau et que le navigateur :
 * start / control / stop, et des événements « status ». Le choix de l'appareil se fait dans la
 * fenêtre standard d'Android. Sans les services Google (Fire TV, par exemple), rien n'est proposé.
 */
@CapacitorPlugin(name = "MultiplexCast")
public class CastPlugin extends Plugin {
    private CastContext cast;
    private PluginCall pending;
    private JSObject pendingMedia;
    private boolean choosing;
    private RemoteMediaClient client;
    private final RemoteMediaClient.Callback mediaCallback = new RemoteMediaClient.Callback() {
        @Override
        public void onStatusUpdated() {
            emit(null);
        }
    };
    private final RemoteMediaClient.ProgressListener progress = (at, total) -> emit(null);

    private final SessionManagerListener<CastSession> sessions = new SessionManagerListener<CastSession>() {
        @Override public void onSessionStarted(CastSession s, String id) { choosing = false; loadPending(s); }
        @Override public void onSessionResumed(CastSession s, boolean b) { choosing = false; loadPending(s); }
        @Override public void onSessionStartFailed(CastSession s, int error) { finishPending(false, "start-failed"); }
        @Override public void onSessionEnded(CastSession s, int error) { detach(); emitClosed(); }
        @Override public void onSessionStarting(CastSession s) {}
        @Override public void onSessionEnding(CastSession s) {}
        @Override public void onSessionResuming(CastSession s, String id) {}
        @Override public void onSessionResumeFailed(CastSession s, int error) {}
        @Override public void onSessionSuspended(CastSession s, int reason) {}
    };

    @Override
    public void load() {
        try {
            cast = CastContext.getSharedInstance(getContext());
            cast.getSessionManager().addSessionManagerListener(sessions, CastSession.class);
        } catch (Exception e) {
            // Pas de services Google sur cet appareil : l'envoi n'est pas proposé.
            cast = null;
        }
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", cast != null);
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (cast == null) {
            reply(call, false, "unavailable");
            return;
        }
        if (pending != null) finishPending(false, "cancel");
        pending = call;
        pendingMedia = call.getData();
        call.setKeepAlive(true);
        getActivity().runOnUiThread(() -> {
            CastSession current = cast.getSessionManager().getCurrentCastSession();
            if (current != null && current.isConnected()) {
                loadPending(current);
                return;
            }
            // Fenêtre standard d'Android : la personne choisit l'appareil, ou annule.
            MediaRouteSelector selector = new MediaRouteSelector.Builder()
                .addControlCategory(CastMediaControlIntent.categoryForCast(CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID))
                .build();
            MediaRouteChooserDialog dialog = new MediaRouteChooserDialog(getActivity());
            dialog.setRouteSelector(selector);
            choosing = false;
            MediaRouter router = MediaRouter.getInstance(getContext());
            dialog.setOnDismissListener(d -> {
                // Un appareil choisi : la séance démarre et onSessionStarted prend le relais.
                MediaRouter.RouteInfo route = router.getSelectedRoute();
                choosing = !route.isDefault() && route.matchesSelector(selector);
                if (!choosing) finishPending(false, "cancel");
            });
            dialog.show();
        });
    }

    private void loadPending(CastSession session) {
        if (pending == null || pendingMedia == null) return;
        JSObject m = pendingMedia;
        boolean episode = "episode".equals(m.getString("kind"));
        MediaMetadata md = new MediaMetadata(episode ? MediaMetadata.MEDIA_TYPE_TV_SHOW : MediaMetadata.MEDIA_TYPE_MOVIE);
        String title = m.getString("title", "");
        String sub = m.getString("sub", "");
        if (episode) {
            md.putString(MediaMetadata.KEY_SERIES_TITLE, title);
            md.putString(MediaMetadata.KEY_TITLE, sub == null || sub.isEmpty() ? title : sub);
        } else {
            md.putString(MediaMetadata.KEY_TITLE, title);
            if (sub != null && !sub.isEmpty()) md.putString(MediaMetadata.KEY_SUBTITLE, sub);
        }
        String image = m.getString("image");
        if (image != null && image.startsWith("http")) md.addImage(new WebImage(Uri.parse(image)));
        String url = m.getString("url", "");
        if (!url.startsWith("http")) {
            finishPending(false, "invalid");
            return;
        }
        double duration = m.optDouble("duration", 0);
        MediaInfo info = new MediaInfo.Builder(url)
            .setStreamType(MediaInfo.STREAM_TYPE_BUFFERED)
            .setContentType("video/mp4".equals(m.getString("contentType")) ? "video/mp4" : "application/x-mpegURL")
            .setMetadata(md)
            .setStreamDuration(duration > 0 ? (long) (duration * 1000) : MediaInfo.UNKNOWN_DURATION)
            .build();
        attach(session);
        if (client == null) {
            finishPending(false, "no-client");
            return;
        }
        MediaLoadRequestData req = new MediaLoadRequestData.Builder()
            .setMediaInfo(info)
            .setAutoplay(true)
            .setCurrentTime((long) (m.optDouble("start", 0) * 1000))
            .build();
        client.load(req).setResultCallback(r -> finishPending(r.getStatus().isSuccess(), r.getStatus().isSuccess() ? null : "load-failed"));
    }

    private void attach(CastSession session) {
        RemoteMediaClient c = session.getRemoteMediaClient();
        if (c == client) return;
        detach();
        client = c;
        if (client != null) {
            client.registerCallback(mediaCallback);
            client.addProgressListener(progress, 1000);
        }
    }

    private void detach() {
        if (client != null) {
            client.unregisterCallback(mediaCallback);
            client.removeProgressListener(progress);
        }
        client = null;
    }

    private void finishPending(boolean ok, String error) {
        PluginCall call = pending;
        pending = null;
        pendingMedia = null;
        if (call != null) {
            reply(call, ok, error);
            getBridge().releaseCall(call);
        }
    }

    private void reply(PluginCall call, boolean ok, String error) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        if (error != null) r.put("error", error);
        call.resolve(r);
    }

    private void emit(String forced) {
        if (client == null) return;
        CastSession session = cast != null ? cast.getSessionManager().getCurrentCastSession() : null;
        MediaStatus st = client.getMediaStatus();
        JSObject s = new JSObject();
        String state = forced;
        if (state == null) {
            int ps = st != null ? st.getPlayerState() : MediaStatus.PLAYER_STATE_UNKNOWN;
            state = ps == MediaStatus.PLAYER_STATE_PLAYING ? "playing"
                : ps == MediaStatus.PLAYER_STATE_PAUSED ? "paused"
                : ps == MediaStatus.PLAYER_STATE_BUFFERING || ps == MediaStatus.PLAYER_STATE_LOADING ? "buffering"
                : ps == MediaStatus.PLAYER_STATE_IDLE ? "idle" : "connecting";
            if (st != null && ps == MediaStatus.PLAYER_STATE_IDLE) s.put("ended", st.getIdleReason() == MediaStatus.IDLE_REASON_FINISHED);
        }
        s.put("state", state);
        s.put("time", client.getApproximateStreamPosition() / 1000.0);
        s.put("duration", Math.max(0, client.getStreamDuration()) / 1000.0);
        s.put("volume", session != null ? session.getVolume() : 1);
        s.put("muted", session != null && session.isMute());
        s.put("device", session != null && session.getCastDevice() != null ? session.getCastDevice().getFriendlyName() : "");
        notifyListeners("status", s);
    }

    private void emitClosed() {
        JSObject s = new JSObject();
        s.put("state", "closed");
        s.put("reason", "stopped");
        s.put("time", 0);
        s.put("duration", 0);
        s.put("volume", 1);
        s.put("muted", false);
        s.put("device", "");
        notifyListeners("status", s);
    }

    @PluginMethod
    public void control(PluginCall call) {
        String action = call.getString("action", "");
        getActivity().runOnUiThread(() -> {
            CastSession session = cast != null ? cast.getSessionManager().getCurrentCastSession() : null;
            try {
                if ("volume".equals(action) && session != null) session.setVolume(Math.max(0, Math.min(1, call.getDouble("value", 1.0))));
                else if ("mute".equals(action) && session != null) session.setMute(Boolean.TRUE.equals(call.getBoolean("value", false)));
                else if (client != null && "play".equals(action)) client.play();
                else if (client != null && "pause".equals(action)) client.pause();
                else if (client != null && "seek".equals(action)) {
                    long at = (long) (Math.max(0, call.getDouble("value", 0.0)) * 1000);
                    client.seek(new MediaSeekOptions.Builder().setPosition(at).build());
                }
            } catch (Exception e) {
                // Appareil déconnecté entre-temps : la séance se termine d'elle-même.
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (cast != null) cast.getSessionManager().endCurrentSession(true);
            call.resolve();
        });
    }
}
