int ENA = 9;   // PWM pin
int IN1 = 8;
int IN2 = 7;

String input = "";

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  Serial.begin(9600);
  Serial.println("Type 'g' to start...");
}

void loop() {
  // Check if there's input from Serial Monitor
  if (Serial.available()) {
    input = Serial.readStringUntil('\n');
    input.trim(); // remove spaces/newlines

    if (input == "g") {
      Serial.println("Running...");

      runSequence();  // execute once

      Serial.println("Stopped.");
    }
  }
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


  //feed out
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
  //after push
  digitalWrite(LED_BUILTIN, HIGH);
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, 255);
  delay(500);

  // brake
analogWrite(ENA, 0);
    delay(1000);
}