int ENA = 9;   // PWM pin
int IN1 = 8;
int IN2 = 7;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(ENA, OUTPUT);
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
}

void loop() {
  // Feed IN
  for(int i = 0; i < 3; i++){
    digitalWrite(LED_BUILTIN, HIGH);
    digitalWrite(IN1, HIGH);
    digitalWrite(IN2, LOW);
    analogWrite(ENA, 200);
    delay(100); // run for 100 ms

    digitalWrite(LED_BUILTIN, LOW);
    analogWrite(ENA, 0);
    delay(100);
  }
  delay(500);

  //Feed OUT orig was i <3; pwn = 200
  for(int i = 0; i < 4; i++){
    digitalWrite(LED_BUILTIN, HIGH);
    digitalWrite(IN1, LOW);
    digitalWrite(IN2, HIGH);
    analogWrite(ENA, 150);
    delay(100); // run for 100 ms

    digitalWrite(LED_BUILTIN, LOW);
    analogWrite(ENA, 0);
    delay(100);
  }
  delay(2000);

}