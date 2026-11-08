import AVKit
import MediaPlayer
import SwiftUI
import UIKit

@main struct CallHarnessApp: App {
    @StateObject private var model = HarnessModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var diagnosticsCopied = false
    var body: some Scene {
        WindowGroup {
            Form {
                Section("GChat — аудиостенд") {
                    Text("Технический прототип. APNs и PushKit выключены.")
                    Button {
                        UIPasteboard.general.string = model.diagnostics
                        diagnosticsCopied = true
                    } label: {
                        Label("Скопировать диагностику", systemImage: "doc.on.doc")
                    }
                    TextField("HTTPS-адрес тестового backend", text: $model.serverURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .disabled(model.signedIn || model.working)
                    if !model.signedIn {
                        TextField("Тестовый логин", text: $model.login)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        SecureField("Пароль", text: $model.password)
                        Button("Войти и разрешить микрофон") { Task { await model.connect() } }
                            .disabled(model.working)
                    } else {
                        Text(model.online ? "WSS: online" : "WSS: reconnecting")
                        Button("Выйти") { Task { await model.logout() } }
                    }
                }
                if model.signedIn {
                    Section("Тестовый звонок") {
                        TextField("UUID второго тестового пользователя", text: $model.peerID)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                        Button("Позвонить тестовому peer") { Task { await model.place() } }
                            .disabled(!model.online || !["нет звонка", "ended"].contains(model.phase))
                        Text("Состояние: " + model.phase)
                        Text(model.audioConnected ? "Медиа: connected" : "Медиа: disconnected")
                        Text("Последнее событие: " + model.lastCallEvent)
                        if model.incoming {
                            Button("Ответить через CallKit") { Task { await model.answer() } }
                        }
                        Button("Завершить / отклонить") { Task { await model.end() } }
                            .disabled(["нет звонка", "ended"].contains(model.phase))
                        Button(model.muted ? "Включить микрофон" : "Выключить микрофон") { model.mute() }
                        if model.audioConnected {
                            Button("Включить камеру звонка") { Task { await model.startCamera() } }
                                .disabled(model.hasCamera)
                        }
                        if model.hasCamera {
                            Text("Камера: " + model.cameraStatus + "; PiP: " + model.pictureInPicture)
                            Button("Сменить камеру") { Task { await model.switchCamera() } }.disabled(model.recordingVideo)
                            Button("Сохранить фото") { Task { await model.takePhoto() } }
                            Button(model.recordingVideo ? "Остановить запись" : "Записать видео без звука") { Task { await model.recordVideo() } }
                            Button("Закрыть камеру") { Task { await model.closeCamera() } }
                        }
                        if model.audioConnected {
                            HStack {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("Аудиоустройство")
                                    Text(model.outputDevice)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                CallAudioDeviceControl()
                                    .frame(width: 44, height: 44)
                                    .accessibilityLabel("Выбрать аудиоустройство")
                            }
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Громкость разговора")
                                CallVolumeControl()
                                    .frame(height: 44)
                                    .accessibilityLabel("Громкость разговора")
                            }
                        }
                    }
                }
                if !model.error.isEmpty { Section("Результат") { Text(model.error) } }
            }
            .safeAreaInset(edge:.bottom) {
                if model.hasCamera {
                    VStack(spacing:4) {
                        CallCameraPreview(camera:model.camera).frame(height:model.cameraExpanded ? 240 : 90)
                        Button(model.cameraExpanded ? "Компактный preview" : "Большой preview") { model.cameraExpanded.toggle() }
                    }.padding(8).background(.regularMaterial)
                }
            }
            .task(id: scenePhase) {
                model.sceneChanged(String(describing: scenePhase))
                if scenePhase == .active { await model.foreground() }
            }
            .alert("Диагностика скопирована", isPresented: $diagnosticsCopied) {
                Button("ОК", role: .cancel) {}
            } message: {
                Text("Вставь текст в чат. Пароль, токены и данные сигнализации не копируются.")
            }
        }
    }
}

private struct CallAudioDeviceControl: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView(frame: .zero)
        view.prioritizesVideoDevices = false
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {
        // iOS owns the device list, route selection and checkmark.
    }
}

private struct CallVolumeControl: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        view.showsRouteButton = false
        return view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {
        // iOS owns the value and synchronizes it with hardware volume buttons.
    }
}
