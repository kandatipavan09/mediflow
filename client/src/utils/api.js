// DOCBEE Centralized REST API client with credentials support

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');

export const api = {
  // Authentication
  async login(credentials) {
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(credentials)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data.message || 'Invalid email or password'
        };
      }
      return { success: true, ...data };
    } catch (err) {
      return {
        success: false,
        status: 500,
        message: 'Unable to reach authentication server. Please check your connection.'
      };
    }
  },

  async register(userData) {
    try {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(userData)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data.message || 'Registration failed'
        };
      }
      return { success: true, ...data };
    } catch (err) {
      return {
        success: false,
        status: 500,
        message: 'Network error during registration.'
      };
    }
  },

  async logout() {
    try {
      const res = await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json().catch(() => ({}));
      return data;
    } catch (err) {
      return { success: true };
    }
  },

  async getMe() {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        credentials: 'include'
      });
      if (!res.ok) {
        return { success: false, status: res.status, user: null };
      }
      const data = await res.json().catch(() => ({}));
      return data;
    } catch (err) {
      return { success: false, status: 500, user: null };
    }
  },

  async forgotPassword(email) {
    try {
      const res = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data.message || 'Unable to process recovery request.'
        };
      }
      return { success: true, ...data };
    } catch (err) {
      return {
        success: false,
        status: 500,
        message: 'Network error. Please check your connection.'
      };
    }
  },

  async verifyOtp(email, otp) {
    try {
      const res = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, otp })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data.message || 'Invalid or expired verification code.'
        };
      }
      return { success: true, ...data };
    } catch (err) {
      return {
        success: false,
        status: 500,
        message: 'Network error verifying code.'
      };
    }
  },

  async resetPassword(email, resetToken, newPassword) {
    try {
      const res = await fetch(`${API_BASE}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, resetToken, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data.message || 'Unable to reset password.'
        };
      }
      return { success: true, ...data };
    } catch (err) {
      return {
        success: false,
        status: 500,
        message: 'Network error resetting password.'
      };
    }
  },

  async changePassword(currentPassword, newPassword) {
    try {
      const res = await fetch(`${API_BASE}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          success: false,
          status: res.status,
          message: data.message || 'Failed to update password.'
        };
      }
      return { success: true, ...data };
    } catch (err) {
      return {
        success: false,
        status: 500,
        message: 'Network error updating password.'
      };
    }
  },


  // Locations
  async getLocations() {
    const res = await fetch(`${API_BASE}/locations`, {
      credentials: 'include'
    });
    return res.json();
  },

  // Doctors
  async getDoctors(params = {}) {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}/doctors${query ? `?${query}` : ''}`, {
      credentials: 'include'
    });
    return res.json();
  },

  async getDoctorById(id) {
    const res = await fetch(`${API_BASE}/doctors/${id}`, {
      credentials: 'include'
    });
    return res.json();
  },

  // Appointments
  async getAppointments(params = {}) {
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}/appointments${query ? `?${query}` : ''}`, {
      credentials: 'include'
    });
    return res.json();
  },

  async getAppointmentById(id) {
    const res = await fetch(`${API_BASE}/appointments/${id}`, {
      credentials: 'include'
    });
    return res.json();
  },

  async bookAppointment(payload) {
    const res = await fetch(`${API_BASE}/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  // Queue
  async getDoctorQueue(doctorId) {
    const res = await fetch(`${API_BASE}/queue/${doctorId}`, {
      credentials: 'include'
    });
    return res.json();
  },

  async callNextPatient(doctorId) {
    const res = await fetch(`${API_BASE}/queue/${doctorId}/call-next`, {
      method: 'POST',
      credentials: 'include'
    });
    return res.json();
  },

  async startConsultation(doctorId, payload = {}) {
    const res = await fetch(`${API_BASE}/queue/${doctorId}/start-consultation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  async completeConsultation(doctorId, payload = {}) {
    const res = await fetch(`${API_BASE}/queue/${doctorId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  // Consultation Reports & PDF
  async getConsultationReports() {
    const res = await fetch(`${API_BASE}/consultations/reports`, {
      credentials: 'include'
    });
    return res.json();
  },

  async getConsultationReportById(id) {
    const res = await fetch(`${API_BASE}/consultations/reports/${id}`, {
      credentials: 'include'
    });
    return res.json();
  },

  getConsultationReportPdfUrl(id) {
    return `${API_BASE}/consultations/reports/${id}/pdf`;
  },

  // Notifications
  async getNotifications() {
    const res = await fetch(`${API_BASE}/notifications`, {
      credentials: 'include'
    });
    return res.json();
  },

  async markNotificationRead(id) {
    const res = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: 'PATCH',
      credentials: 'include'
    });
    return res.json();
  },

  async markAllNotificationsRead() {
    const res = await fetch(`${API_BASE}/notifications/mark-all-read`, {
      method: 'PATCH',
      credentials: 'include'
    });
    return res.json();
  },

  async dismissNotification(id) {
    const res = await fetch(`${API_BASE}/notifications/${id}`, {
      method: 'DELETE',
      credentials: 'include'
    });
    return res.json();
  },

  // AI Services
  async submitPreConsultation(payload) {
    const res = await fetch(`${API_BASE}/ai/pre-consultation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  async generateConsultationSummary(payload) {
    const res = await fetch(`${API_BASE}/ai/generate-summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  // Patient, Family & Documents
  async getPatientProfile() {
    const res = await fetch(`${API_BASE}/patient/profile`, {
      credentials: 'include'
    });
    return res.json();
  },

  async updatePatientProfile(data) {
    const res = await fetch(`${API_BASE}/patient/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data)
    });
    return res.json();
  },

  async getFamilyMembers() {
    const res = await fetch(`${API_BASE}/family`, {
      credentials: 'include'
    });
    return res.json();
  },

  async addFamilyMember(member) {
    const res = await fetch(`${API_BASE}/family`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(member)
    });
    return res.json();
  },

  async getDocuments() {
    const res = await fetch(`${API_BASE}/documents`, {
      credentials: 'include'
    });
    return res.json();
  },

  async uploadDocument(doc) {
    const res = await fetch(`${API_BASE}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(doc)
    });
    return res.json();
  },

  async toggleDocumentShare(docId) {
    const res = await fetch(`${API_BASE}/documents/${docId}/toggle-share`, {
      method: 'PATCH',
      credentials: 'include'
    });
    return res.json();
  },

  // Demo Reset
  async resetDemo() {
    const res = await fetch(`${API_BASE}/demo/reset`, {
      method: 'POST',
      credentials: 'include'
    });
    return res.json();
  },

  // Healthcare Interoperability & FHIR Provider Management
  async getHealthcareStatus() {
    try {
      const res = await fetch(`${API_BASE}/healthcare/status`, {
        credentials: 'include'
      });
      return res.json();
    } catch (e) {
      return { success: false, data: { activeMode: 'synthetic', providerName: 'MediFlow Synthetic Provider' } };
    }
  },

  async switchHealthcareProvider(mode) {
    const res = await fetch(`${API_BASE}/healthcare/switch-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ mode })
    });
    return res.json();
  }
};
