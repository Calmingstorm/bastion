package email

import (
	"fmt"
	"net/smtp"
	"strings"

	"github.com/Calmingstorm/bastion/server/internal/config"
)

type Service struct {
	cfg *config.SMTPConfig
}

func New(cfg *config.SMTPConfig) *Service {
	return &Service{cfg: cfg}
}

func (s *Service) Send(to, subject, htmlBody string) error {
	addr := fmt.Sprintf("%s:%s", s.cfg.Host, s.cfg.Port)
	auth := smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)

	// Build the email message
	var msg strings.Builder
	msg.WriteString("From: " + s.cfg.From + "\r\n")
	msg.WriteString("To: " + to + "\r\n")
	msg.WriteString("Subject: " + subject + "\r\n")
	msg.WriteString("MIME-Version: 1.0\r\n")
	msg.WriteString("Content-Type: text/html; charset=\"utf-8\"\r\n")
	msg.WriteString("\r\n")
	msg.WriteString(htmlBody)

	return smtp.SendMail(addr, auth, s.cfg.From, []string{to}, []byte(msg.String()))
}
