package ug.buildable.gadf.watch

sealed interface UiState {
    data object CheckingSession : UiState
    data object LoggedOut : UiState
    data object Idle : UiState
    data object Listening : UiState
    data object Sending : UiState
    data object Speaking : UiState
    data class Error(val message: String) : UiState
}
