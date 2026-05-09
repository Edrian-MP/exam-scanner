const int scannerSensor = 10;   // near-scanner paper sensor
const int traySensor = 12;      // tray paper-presence sensor
const int ledPin = LED_BUILTIN;
const int BUZZER_PIN = 11;   // active buzzer signal pin

int lastScannerState = -1;
int lastTrayState = -1;

int ENA = 9;   // PWM pin
int IN1 = 8;
int IN2 = 7;

String input = "";

const unsigned long PAPER_REACH_TIMEOUT_MS = 3000;
const unsigned long PRE_FEED_CLEAR_TIMEOUT_MS = 30000;
const unsigned long POST_CLEAR_DELAY_MS = 1000;
const unsigned long SENSOR_POLL_MS = 10;
const unsigned long LONG_BEEP_MS = 500;
const unsigned long SHORT_BEEP_MS = 150;
const unsigned long BEEP_GAP_MS = 150;
const unsigned long JAM_ALARM_ON_MS = 800;
const unsigned long JAM_ALARM_OFF_MS = 350;
const int MAX_FEED_ATTEMPTS = 3;

bool jamAlarmActive = false;
bool jamAlarmToneOn = false;
unsigned long jamAlarmLastToggleAt = 0;

// change this if your sensor is inverted
bool isScannerPaperDetected() {
  return digitalRead(scannerSensor) == HIGH;
}

bool isTrayPaperDetected() {
  return digitalRead(traySensor) == HIGH;
}

void stopMotor() {
  analogWrite(ENA, 0);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  digitalWrite(ledPin, LOW);
}

void buzzerOn() {
  digitalWrite(BUZZER_PIN, HIGH);
}

void buzzerOff() {
  digitalWrite(BUZZER_PIN, LOW);
}

void beepLongOnce() {
  buzzerOn();
  delay(LONG_BEEP_MS);
  buzzerOff();
}

void beepShortPattern(int count) {
  for (int i = 0; i < count; i++) {
    buzzerOn();
    delay(SHORT_BEEP_MS);
    buzzerOff();
    if (i < count - 1) {
      delay(BEEP_GAP_MS);
    }
  }
}

void startJamAlarm() {
  jamAlarmActive = true;
  jamAlarmToneOn = true;
  jamAlarmLastToggleAt = millis();
  buzzerOn();
}

void stopJamAlarm() {
  jamAlarmActive = false;
  jamAlarmToneOn = false;
  buzzerOff();
}

void stopJamAlarmIfSensorClear() {
  if (jamAlarmActive && !isScannerPaperDetected()) {
    stopJamAlarm();
  }
}

void updateJamAlarm() {
  if (!jamAlarmActive) {
    return;
  }

  stopJamAlarmIfSensorClear();
  if (!jamAlarmActive) {
    return;
  }

  unsigned long now = millis();
  unsigned long interval = jamAlarmToneOn ? JAM_ALARM_ON_MS : JAM_ALARM_OFF_MS;
  if (now - jamAlarmLastToggleAt >= interval) {
    jamAlarmToneOn = !jamAlarmToneOn;
    jamAlarmLastToggleAt = now;
    if (jamAlarmToneOn) {
      buzzerOn();
    } else {
      buzzerOff();
    }
  }
}

bool waitForScannerPaperState(bool targetState, unsigned long timeoutMs) {
  unsigned long startedAt = millis();

  while (isScannerPaperDetected() != targetState) {
    if (millis() - startedAt >= timeoutMs) {
      return false;
    }
    delay(SENSOR_POLL_MS);
  }

  return true;
}

void setup() {
  pinMode(ledPin, OUTPUT);
  pinMode(scannerSensor, INPUT);
  pinMode(traySensor, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  Serial.begin(9600);
  Serial.println("READY");

  stopMotor();
  buzzerOff();
}

void loop() {
  updateJamAlarm();

  int currentScannerState = digitalRead(scannerSensor);
  int currentTrayState = digitalRead(traySensor);

  if (currentScannerState != lastScannerState) {
    Serial.print("scannerSensor state: ");
    Serial.println(currentScannerState);
    lastScannerState = currentScannerState;
  }

  if (currentTrayState != lastTrayState) {
    Serial.print("traySensor state: ");
    Serial.println(currentTrayState);
    lastTrayState = currentTrayState;
  }

  if (Serial.available()) {
    input = Serial.readStringUntil('\n');
    input.trim();

    if (input == "FEED" || input == "g") {
      feedOneSheet();
    } else if (input == "BEEP_START") {
      beepLongOnce();
    } else if (input == "BEEP_FINISH") {
      beepShortPattern(3);
    } else if (input == "BEEP_CANCEL_FAILURES") {
      beepShortPattern(5);
    }
  }
}

void feedOneSheet() {
  if (!isTrayPaperDetected()) {
    stopMotor();
    Serial.println("NO_PAPER");
    return;
  }

  if (!waitForScannerPaperState(false, PRE_FEED_CLEAR_TIMEOUT_MS)) {
    stopMotor();
    startJamAlarm();
    Serial.println("PAPER_JAM");
    return;
  }

  delay(POST_CLEAR_DELAY_MS);

  for (int attempt = 1; attempt <= MAX_FEED_ATTEMPTS; attempt++) {
    runSequence();
    stopMotor();

    if (waitForScannerPaperState(true, PAPER_REACH_TIMEOUT_MS)) {
      stopMotor();
      Serial.println("SHEET_FED");
      return;
    }
  }

  stopMotor();
  startJamAlarm();
  Serial.println("PAPER_JAM");
}

void runSequence() {
  // Feed IN
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, HIGH);
  digitalWrite(IN2, LOW);
  analogWrite(ENA, 255);
  digitalWrite(LED_BUILTIN, LOW);
  delay(650);

  // brake
  analogWrite(ENA, 0);
  delay(500);

  // feed out
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 200);
  delay(500);

  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 200);
  delay(800);

  analogWrite(ENA, 0);
  delay(500);

  // after push
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 255);
  delay(500);

  // brake
  analogWrite(ENA, 0);
  delay(1000);

  stopMotor();
}
