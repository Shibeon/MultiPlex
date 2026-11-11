package app.multiplex.client;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 15+ affiche les applications bord à bord : on réserve la place
        // des barres système et des encoches pour que l'interface ne passe pas dessous.
        View root = findViewById(android.R.id.content);
        root.setBackgroundColor(Color.parseColor("#0f1115"));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        // Bouton Retour (téléphone et télécommande) : l'app web décide ; à la racine, on quitte.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                getBridge().getWebView().evaluateJavascript(
                    "(function(){return !!(window.multiplexBack && window.multiplexBack())})()",
                    handled -> { if (!"true".equals(handled)) moveTaskToBack(true); }
                );
            }
        });
    }
}
