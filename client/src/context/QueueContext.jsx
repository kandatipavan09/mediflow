import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from '../utils/api';
import { soundFx } from '../utils/sound';

const QueueContext = createContext(null);

export function QueueProvider({ children }) {
  const [queues, setQueues] = useState({}); // doctorId -> queueStats
  const [activeAppointment, setActiveAppointment] = useState(null); // current tracked appointment for patient
  const [latestNotification, setLatestNotification] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const [recentQueueEvent, setRecentQueueEvent] = useState(null);

  const fetchQueue = useCallback(async (doctorId = "doc-1") => {
    try {
      const res = await api.getDoctorQueue(doctorId);
      if (res.success) {
        setQueues(prev => ({ ...prev, [doctorId]: res.data }));
      }
    } catch (err) {
      console.error('Error fetching queue:', err);
    }
  }, []);

  // Connect to SSE stream
  useEffect(() => {
    fetchQueue("doc-1");

    const sseBase = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');
    const eventSource = new EventSource(`${sseBase}/events`);

    eventSource.onopen = () => {
      setIsConnected(true);
    };

    eventSource.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);

        if (payload.type === 'queue_updated') {
          const { doctorId, queue, action, currentPatient } = payload.data;
          
          setQueues(prev => ({ ...prev, [doctorId]: queue }));
          setRecentQueueEvent({ action, currentPatient, timestamp: Date.now() });

          // If current patient is tracking an appointment with this doctor
          if (activeAppointment && activeAppointment.doctorId === doctorId) {
            // Check if patient became now consulting
            if (queue.nowConsulting && queue.nowConsulting.id === activeAppointment.id) {
              soundFx.playSuccessAlert();
              setActiveAppointment(prev => ({ ...prev, status: 'now_consulting', queuePosition: 1 }));
              setLatestNotification({
                title: "🟢 It's Your Turn!",
                message: `Dr. ${queue.doctorName} is ready. Please join your consultation now.`,
                type: 'success'
              });
            } else {
              // Check waiting queue position
              const foundInWaiting = queue.waitingList.find(w => w.id === activeAppointment.id);
              if (foundInWaiting) {
                const oldPos = activeAppointment.queuePosition;
                const newPos = foundInWaiting.queuePosition;
                const patientsAhead = newPos - 1;

                if (newPos < oldPos) {
                  soundFx.playChime();
                  
                  if (newPos === 2) {
                    setLatestNotification({
                      title: "You're next!",
                      message: "You're next. Please get ready for your consultation.",
                      type: 'info'
                    });
                  } else {
                    setLatestNotification({
                      title: "Queue Position Updated",
                      message: `Your queue position has changed from #${oldPos} to #${newPos}. ${patientsAhead} ${patientsAhead === 1 ? 'patient is' : 'patients are'} now ahead of you.`,
                      type: 'info'
                    });
                  }
                }
                setActiveAppointment(prev => ({ ...prev, queuePosition: newPos, status: 'waiting' }));
              }
            }
          }
        } else if (payload.type === 'appointment_updated') {
          const { appointment } = payload.data;
          if (activeAppointment && activeAppointment.id === appointment.id) {
            setActiveAppointment(appointment);
          }
        } else if (payload.type === 'demo_reset') {
          fetchQueue("doc-1");
          setActiveAppointment(null);
        }
      } catch (err) {
        console.error('Error parsing SSE event:', err);
      }
    };

    eventSource.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      eventSource.close();
    };
  }, [fetchQueue, activeAppointment]);

  const clearNotification = () => setLatestNotification(null);

  return (
    <QueueContext.Provider
      value={{
        queues,
        fetchQueue,
        activeAppointment,
        setActiveAppointment,
        latestNotification,
        clearNotification,
        isConnected,
        recentQueueEvent
      }}
    >
      {children}
    </QueueContext.Provider>
  );
}

export function useQueue() {
  const context = useContext(QueueContext);
  if (!context) throw new Error('useQueue must be used within QueueProvider');
  return context;
}
