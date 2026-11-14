package ai.guideband.app

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import ai.guideband.app.databinding.ActivityMainBinding
import ai.guideband.app.voice.ListeningService

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { updateStatus() }
    private val assistantRole = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { updateStatus() }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state); binding = ActivityMainBinding.inflate(layoutInflater); setContentView(binding.root)
        binding.startAssistant.setOnClickListener { requestAudioAndStart() }
        binding.stopAssistant.setOnClickListener { stopService(Intent(this, ListeningService::class.java)); updateStatus() }
        binding.chooseAssistant.setOnClickListener { chooseAssistant() }
        binding.enableAccessibility.setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        binding.grantNotifications.setOnClickListener { requestPermissions() }
        binding.bridgeButton.setOnClickListener { startActivity(Intent(this, BridgeActivity::class.java)) }
        updateStatus()
    }

    private fun requestPermissions() {
        val list = mutableListOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) list += Manifest.permission.POST_NOTIFICATIONS
        permissions.launch(list.toTypedArray())
    }

    private fun requestAudioAndStart() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) { requestPermissions(); return }
        startForegroundService(Intent(this, ListeningService::class.java)); binding.statusText.text = "Listening · say “Guide…” · notification is visible"
    }

    private fun chooseAssistant() {
        if (Build.VERSION.SDK_INT >= 29) {
            val manager = getSystemService(RoleManager::class.java)
            if (manager.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) { assistantRole.launch(manager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT)); return }
        }
        startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
    }

    private fun updateStatus() { if (!ListeningService.running) binding.statusText.text = "Ready · complete setup, then start listening" }
}
