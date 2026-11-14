package ai.guideband.app.voice

import android.app.*
import android.content.Intent
import android.os.*
import android.speech.*
import android.speech.tts.TextToSpeech
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import ai.guideband.app.MainActivity
import ai.guideband.app.R
import ai.guideband.app.commands.CommandRouter
import java.util.Locale

class ListeningService : LifecycleService(), RecognitionListener, TextToSpeech.OnInitListener {
    companion object { @Volatile var running=false; private const val CHANNEL="guideband_listening";private const val ID=4101 }
    private val handler=Handler(Looper.getMainLooper());private var recognizer:SpeechRecognizer?=null;private lateinit var tts:TextToSpeech;private var stopping=false
    override fun onCreate(){super.onCreate();running=true;createChannel();tts=TextToSpeech(this,this);startForeground(ID,notification("Listening for “Guide…”"));recognizer=SpeechRecognizer.createSpeechRecognizer(this).also{it.setRecognitionListener(this)};listen()}
    private fun listen(){if(stopping)return;val i=Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS,true).putExtra(RecognizerIntent.EXTRA_MAX_RESULTS,3);try{recognizer?.startListening(i)}catch(_:Exception){restart()}}
    private fun restart(){handler.removeCallbacksAndMessages(null);handler.postDelayed({listen()},650)}
    override fun onResults(b:Bundle){val phrases=b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty();phrases.firstOrNull{it.lowercase().contains("guide")||it.lowercase().contains("гайд")||it.lowercase().contains("stop listening")}?.let{handle(it)};restart()}
    override fun onPartialResults(b:Bundle){b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let{if(it.lowercase().contains("stop listening"))handle(it)}}
    private fun handle(text:String){val plan=CommandRouter.plan(text);speak(plan.summary);if(plan.command=="stop"){stopSelf();return};CommandRouter.dispatch(this,text)}
    private fun speak(text:String){tts.speak(text,TextToSpeech.QUEUE_FLUSH,null,"guideband")}
    private fun notification(text:String):Notification{val open=PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java),PendingIntent.FLAG_IMMUTABLE);val stop=PendingIntent.getBroadcast(this,1,Intent(this,StopReceiver::class.java),PendingIntent.FLAG_IMMUTABLE);return NotificationCompat.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("GuideBand is active").setContentText(text).setOngoing(true).setContentIntent(open).addAction(0,"Stop",stop).setCategory(Notification.CATEGORY_SERVICE).build()}
    private fun createChannel(){getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL,"GuideBand listening",NotificationManager.IMPORTANCE_LOW).apply{description="Visible whenever GuideBand listens for commands"})}
    override fun onDestroy(){stopping=true;running=false;handler.removeCallbacksAndMessages(null);recognizer?.destroy();tts.shutdown();super.onDestroy()}
    override fun onInit(s:Int){if(s==TextToSpeech.SUCCESS)tts.language=Locale.getDefault()}
    override fun onError(e:Int)=restart();override fun onReadyForSpeech(p:Bundle?){};override fun onBeginningOfSpeech(){};override fun onRmsChanged(v:Float){};override fun onBufferReceived(b:ByteArray?){};override fun onEndOfSpeech(){};override fun onEvent(t:Int,p:Bundle?){}
}
